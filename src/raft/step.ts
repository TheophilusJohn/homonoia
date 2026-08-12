import { entriesFrom, entryAt, lastLogIndex, lastLogTerm, truncateBefore } from './log'
import type {
  AppendEntriesRequest,
  Command,
  Event,
  LogEntry,
  Message,
  NodeId,
  NodeState,
  StepResult,
  TickEvent,
} from './types'

/**
 * Ticks between leader heartbeats.
 *
 * Must stay well below the minimum election timeout, or a healthy leader will
 * be voted out between beats. The driver draws election timeouts from a range
 * an order of magnitude above this.
 */
export const HEARTBEAT_INTERVAL = 15

/**
 * The Raft core.
 *
 * Pure: same (state, event) always yields the same result, no I/O, no clock, no
 * randomness, input never mutated. The driver routes `outbox` and decides when
 * the next event arrives.
 *
 * Milestone 3 completes term handling, leader election and log replication.
 * Snapshots, membership changes and client sessions are deliberately out of
 * scope.
 */
export function step(state: NodeState, event: Event): StepResult {
  switch (event.type) {
    case 'tick':
      return tick(state, event)

    case 'client-command':
      return clientCommand(state, event.command)

    case 'deliver':
      return deliver(state, event.message)
  }
}

// --- Time ---

function tick(state: NodeState, event: TickEvent): StepResult {
  // Figure 2, Leaders: "Upon election ... repeat during idle periods to prevent
  // election timeouts." A leader runs no election timer of its own.
  if (state.role === 'leader') {
    const heartbeatElapsed = state.heartbeatElapsed + 1
    if (heartbeatElapsed < HEARTBEAT_INTERVAL) {
      return { state: { ...state, heartbeatElapsed }, outbox: [] }
    }
    const beating: NodeState = { ...state, heartbeatElapsed: 0 }
    return { state: beating, outbox: replicate(beating) }
  }

  // Figure 2, Followers: "If election timeout elapses without receiving
  // AppendEntries from current leader or granting vote to candidate: convert to
  // candidate." Candidates run the same timer, which is what breaks a split vote.
  const electionElapsed = state.electionElapsed + 1
  if (electionElapsed < state.electionTimeout) {
    return { state: { ...state, electionElapsed }, outbox: [] }
  }
  return startElection({ ...state, electionElapsed }, event.randomElectionTimeout)
}

// --- Clients ---

/**
 * Figure 2, Leaders: "If command received from client: append entry to local
 * log, respond after entry applied to state machine."
 *
 * Only a leader may append. A follower silently ignores the command; real
 * clients are redirected to the leader, and client session handling is out of
 * scope for this project.
 */
function clientCommand(state: NodeState, command: Command): StepResult {
  if (state.role !== 'leader') return { state, outbox: [] }

  const entry: LogEntry = { term: state.currentTerm, command }
  const leader: NodeState = { ...state, log: [...state.log, entry] }

  // Advancing here only matters for a single-node cluster, which is its own
  // majority; with peers this is a no-op until responses arrive.
  return { state: applyCommitted(advanceCommit(leader)), outbox: replicate(leader) }
}

// --- Messages ---

function deliver(state: NodeState, message: Message): StepResult {
  const { rpc } = message

  // Figure 2, All Servers:
  //   "If RPC request or response contains term T > currentTerm:
  //    set currentTerm = T, convert to follower."
  // This runs before any other handling of the message, and it applies to
  // responses as well as requests — a leader that ignores the term on a
  // response keeps acting as leader alongside a newer one.
  const current = rpc.term > state.currentTerm ? stepDown(state, rpc.term) : state

  // Figure 2, All Servers:
  //   "If RPC has term < currentTerm, reject it and reply with currentTerm."
  // The reply is what tells a stale sender to step down. After the clause
  // above, this can only be true for a genuinely stale message.
  if (rpc.term < current.currentTerm) {
    return { state: current, outbox: reject(current, message) }
  }

  switch (rpc.type) {
    case 'request-vote-req': {
      // Figure 2, RequestVote receiver 2: "If votedFor is null or candidateId,
      // and candidate's log is at least as up-to-date as receiver's log, grant
      // vote." Re-granting to the same candidate keeps a duplicated request
      // idempotent rather than a double vote.
      const free = current.votedFor === null || current.votedFor === rpc.candidateId
      const voteGranted = free && isAtLeastAsUpToDate(rpc.lastLogTerm, rpc.lastLogIndex, current.log)

      // Granting resets the election timer (§5.2): a node that has just helped
      // someone else's election must not immediately contest it.
      const next: NodeState = voteGranted
        ? { ...current, votedFor: rpc.candidateId, electionElapsed: 0 }
        : current

      return {
        state: next,
        outbox: [
          {
            from: next.id,
            to: message.from,
            rpc: { type: 'request-vote-res', term: next.currentTerm, voteGranted },
          },
        ],
      }
    }

    case 'request-vote-res': {
      // Only a candidate counts votes. A leader that already won, or a node
      // that has since stepped down, ignores late arrivals.
      if (current.role !== 'candidate' || !rpc.voteGranted) {
        return { state: current, outbox: [] }
      }

      // Count each voter once. The network duplicates messages, and a vote
      // counted twice could manufacture a majority that was never granted —
      // two leaders in one term, Election Safety broken.
      if (current.votesGranted.includes(message.from)) {
        return { state: current, outbox: [] }
      }

      const counted: NodeState = {
        ...current,
        votesGranted: [...current.votesGranted, message.from],
      }

      // Figure 2, Candidates: "If votes received from majority of servers:
      // become leader."
      if (counted.votesGranted.length >= majority(counted)) {
        return becomeLeader(counted)
      }
      return { state: counted, outbox: [] }
    }

    case 'append-entries-req':
      return appendEntries(current, message.from, rpc)

    case 'append-entries-res': {
      // A higher term already demoted us above, so reaching here as a
      // non-leader means this is a straggler from a term we have left.
      if (current.role !== 'leader') return { state: current, outbox: [] }

      if (rpc.success) {
        // Figure 2, Leaders: "If successful: update nextIndex and matchIndex
        // for follower." matchIndex only ever moves forward — responses can
        // arrive out of order, and the commit calculation reads matchIndex, so
        // letting a stale response drag it backwards would un-commit entries.
        const matched = Math.max(current.matchIndex[message.from] ?? 0, rpc.matchIndex)
        const leader: NodeState = {
          ...current,
          matchIndex: { ...current.matchIndex, [message.from]: matched },
          nextIndex: { ...current.nextIndex, [message.from]: matched + 1 },
        }
        return { state: applyCommitted(advanceCommit(leader)), outbox: [] }
      }

      // Figure 2, Leaders: "If AppendEntries fails because of log
      // inconsistency: decrement nextIndex and retry."
      //
      // This is the *other* reason a follower says false, and the two must not
      // be confused. A rejection carrying a higher term means we are no longer
      // leader and must step down — handled above, before this point, so any
      // failure still reaching here is at our own term and is therefore a log
      // inconsistency. Walking nextIndex back one index at a time converges on
      // the last entry the follower agrees with.
      const walked = Math.max(1, nextIndexFor(current, message.from) - 1)
      const leader: NodeState = {
        ...current,
        nextIndex: { ...current.nextIndex, [message.from]: walked },
      }
      return { state: leader, outbox: [appendEntriesTo(leader, message.from)] }
    }
  }
}

/**
 * AppendEntries receiver implementation, Figure 2 clauses 2-5.
 *
 * Clause 1 (stale term) is handled by the caller. There is exactly one path in
 * this function that reports success, and it is downstream of the clause 2
 * consistency check.
 */
function appendEntries(state: NodeState, from: NodeId, rpc: AppendEntriesRequest): StepResult {
  // Figure 2, Candidates: "If AppendEntries RPC received from new leader:
  // convert to follower." The term is equal to ours by this point, so the
  // sender is the legitimate leader of this term and the election timer resets.
  const follower: NodeState = {
    ...state,
    role: 'follower',
    electionElapsed: 0,
    votesGranted: [],
  }

  // Clause 2: "Reply false if log doesn't contain an entry at prevLogIndex
  // whose term matches prevLogTerm." prevLogIndex 0 is the empty-log base case
  // and always matches. This is the induction step of Log Matching: agreeing on
  // the entry before the new ones means agreeing on every entry before that.
  const prev = entryAt(follower.log, rpc.prevLogIndex)
  if (rpc.prevLogIndex > 0 && (prev === undefined || prev.term !== rpc.prevLogTerm)) {
    return { state: follower, outbox: [appendReply(follower, from, false, 0)] }
  }

  const log = mergeEntries(follower.log, rpc.prevLogIndex, rpc.entries)

  // Clause 5: "If leaderCommit > commitIndex, set commitIndex =
  // min(leaderCommit, index of last new entry)."
  //
  // The min matters: a leader's commitIndex may cover entries this message did
  // not carry, and committing an index we do not hold would apply an entry that
  // does not exist. The extra max() guards a delayed message whose last new
  // entry sits below what we have already committed — commitIndex must never
  // move backwards.
  const lastNewIndex = rpc.prevLogIndex + rpc.entries.length
  const commitIndex =
    rpc.leaderCommit > follower.commitIndex
      ? Math.max(follower.commitIndex, Math.min(rpc.leaderCommit, lastNewIndex))
      : follower.commitIndex

  const next = applyCommitted({ ...follower, log, commitIndex })
  return { state: next, outbox: [appendReply(next, from, true, lastNewIndex)] }
}

/**
 * Figure 2 clauses 3 and 4: truncate on conflict, then append what is new.
 *
 * The truncation is deliberately not applied to the whole suffix up front. A
 * delayed or duplicated AppendEntries carries entries the follower already has;
 * blindly deleting from `prevLogIndex + 1` and re-appending would, for the
 * window between the two, discard entries the leader still counts as
 * replicated — and if the leader had already committed them on the strength of
 * that matchIndex, a follower could be asked to vote on a log missing committed
 * entries. So an existing entry is removed only when the term at that index
 * genuinely differs; matching entries are left exactly where they are.
 */
function mergeEntries(
  log: readonly LogEntry[],
  prevLogIndex: number,
  entries: readonly LogEntry[],
): readonly LogEntry[] {
  for (let offset = 0; offset < entries.length; offset++) {
    const index = prevLogIndex + 1 + offset
    const existing = entryAt(log, index)

    // Clause 4: past the end of our log — everything from here is new.
    if (existing === undefined) {
      return [...log, ...entries.slice(offset)]
    }

    // Clause 3: a real conflict. Delete this entry and every entry that
    // follows it, then take the leader's version.
    if (existing.term !== entries[offset].term) {
      return [...truncateBefore(log, index), ...entries.slice(offset)]
    }

    // Same index and same term: by Log Matching these are the same entry.
    // Leave it alone.
  }

  return log
}

// --- Transitions ---

/**
 * Adopt a newer term and revert to follower.
 *
 * `votedFor` is scoped to a single term, so advancing the term clears it —
 * otherwise the node would enter the new term believing it had already voted
 * and would refuse every candidate. Candidate and leader volatile state is
 * dropped for the same reason: it belonged to the term being left behind.
 *
 * The election timer resets too, so a demoted leader does not immediately time
 * out and contest the term it just conceded. The log, commitIndex, lastApplied
 * and kv all survive: nothing about a term change invalidates what was already
 * committed.
 */
function stepDown(state: NodeState, term: number): NodeState {
  return {
    ...state,
    role: 'follower',
    currentTerm: term,
    votedFor: null,
    votesGranted: [],
    electionElapsed: 0,
    nextIndex: {},
    matchIndex: {},
  }
}

/**
 * Figure 2, Candidates: "On conversion to candidate, start election:
 * increment currentTerm, vote for self, reset election timer, send RequestVote
 * RPCs to all other servers."
 *
 * The new timeout is the driver's fresh PRNG draw. Randomizing it here is the
 * entire mechanism by which split votes resolve: identical timeouts would make
 * the same nodes contend again at the same instant, forever.
 */
function startElection(state: NodeState, randomElectionTimeout: number): StepResult {
  const term = state.currentTerm + 1

  const candidate: NodeState = {
    ...state,
    role: 'candidate',
    currentTerm: term,
    votedFor: state.id,
    votesGranted: [state.id],
    electionElapsed: 0,
    electionTimeout: randomElectionTimeout,
    nextIndex: {},
    matchIndex: {},
  }

  // A single-node cluster is its own majority and wins immediately.
  if (candidate.votesGranted.length >= majority(candidate)) {
    return becomeLeader(candidate)
  }

  const outbox: Message[] = candidate.peers.map((peer) => ({
    from: candidate.id,
    to: peer,
    rpc: {
      type: 'request-vote-req',
      term,
      candidateId: candidate.id,
      lastLogIndex: lastLogIndex(candidate.log),
      lastLogTerm: lastLogTerm(candidate.log),
    },
  }))

  return { state: candidate, outbox }
}

/**
 * Figure 2, Candidates → Leaders, plus the leader volatile state
 * reinitialization: nextIndex optimistic at last log index + 1, matchIndex
 * pessimistic at 0.
 *
 * The optimism/pessimism split is what makes the consistency check converge:
 * nextIndex is a guess walked back on rejection, matchIndex is only ever raised
 * by a confirmed success. A fresh leader knows nothing about what its followers
 * hold, so matchIndex starts at 0 even for a follower with an identical log.
 *
 * Sends the initial empty AppendEntries immediately ("Upon election: send
 * initial empty AppendEntries RPCs to each server"), which stops every other
 * node's election timer before it can fire.
 */
function becomeLeader(state: NodeState): StepResult {
  const nextIdx = lastLogIndex(state.log) + 1

  const leader: NodeState = {
    ...state,
    role: 'leader',
    heartbeatElapsed: 0,
    nextIndex: Object.fromEntries(state.peers.map((peer) => [peer, nextIdx])),
    matchIndex: Object.fromEntries(state.peers.map((peer) => [peer, 0])),
  }

  return { state: leader, outbox: replicate(leader) }
}

// --- Commit and apply ---

/**
 * Figure 2, Leaders, final clause:
 *
 *   If there exists N > commitIndex such that a majority of matchIndex[i] >= N
 *   and log[N].term === currentTerm, set commitIndex = N.
 *
 * **The current-term test is load-bearing — see the Figure 8 scenario.** An
 * entry from an earlier term sitting on a majority is *not* safe to commit: a
 * node that is still eligible to win a later election may hold a conflicting
 * entry at that index, and committing early lets an acknowledged write be
 * overwritten. A leader commits inherited entries only indirectly, by
 * committing one of its own entries, which by Log Matching carries everything
 * before it along.
 */
function advanceCommit(state: NodeState): NodeState {
  // The leader's own log counts toward the majority; it is trivially
  // replicated to itself.
  const replicated = [
    lastLogIndex(state.log),
    ...state.peers.map((peer) => state.matchIndex[peer] ?? 0),
  ].sort((a, b) => b - a)

  // Sorted descending, the element at majority - 1 is the highest index that a
  // majority of the cluster holds.
  const n = replicated[majority(state) - 1]

  if (n <= state.commitIndex) return state
  if (entryAt(state.log, n)?.term !== state.currentTerm) return state

  return { ...state, commitIndex: n }
}

/**
 * Figure 2, All Servers: "If commitIndex > lastApplied: increment lastApplied,
 * apply log[lastApplied] to state machine."
 *
 * Applied strictly in index order, so every node applies the same commands in
 * the same sequence — which is what State Machine Safety asserts.
 */
function applyCommitted(state: NodeState): NodeState {
  if (state.commitIndex <= state.lastApplied) return state

  let kv = state.kv
  let lastApplied = state.lastApplied

  for (let index = lastApplied + 1; index <= state.commitIndex; index++) {
    const entry = entryAt(state.log, index)
    if (entry === undefined) break
    kv = { ...kv, [entry.command.key]: entry.command.value }
    lastApplied = index
  }

  return { ...state, kv, lastApplied }
}

// --- Helpers ---

/**
 * Is the candidate's log at least as up-to-date as ours?
 *
 * Figure 2, §5.4.1. **Term is compared first and dominates; a longer log does
 * not win.** A node that was partitioned away with a stale leader can hold the
 * longest log in the cluster while every entry past the common prefix is
 * uncommitted garbage from an old term. If length decided the election it would
 * win, then overwrite entries that a later term already committed and
 * acknowledged to a client — Leader Completeness and State Machine Safety both
 * gone. Comparing term first is what guarantees the winner already holds every
 * committed entry.
 */
function isAtLeastAsUpToDate(
  candidateLastTerm: number,
  candidateLastIndex: number,
  log: readonly LogEntry[],
): boolean {
  const ourTerm = lastLogTerm(log)
  if (candidateLastTerm !== ourTerm) return candidateLastTerm > ourTerm
  return candidateLastIndex >= lastLogIndex(log)
}

/** Votes needed to win: a strict majority of the whole cluster, self included. */
function majority(state: NodeState): number {
  return Math.floor((state.peers.length + 1) / 2) + 1
}

function nextIndexFor(state: NodeState, peer: NodeId): number {
  return state.nextIndex[peer] ?? lastLogIndex(state.log) + 1
}

/**
 * AppendEntries to every peer.
 *
 * Figure 2, Leaders: "If last log index >= nextIndex for a follower: send
 * AppendEntries RPC with log entries starting at nextIndex." When there is
 * nothing past nextIndex this produces the empty heartbeat, so the same call
 * serves both purposes.
 */
function replicate(state: NodeState): Message[] {
  return state.peers.map((peer) => appendEntriesTo(state, peer))
}

function appendEntriesTo(state: NodeState, peer: NodeId): Message {
  const nextIdx = nextIndexFor(state, peer)
  const prevLogIndex = nextIdx - 1

  return {
    from: state.id,
    to: peer,
    rpc: {
      type: 'append-entries-req',
      term: state.currentTerm,
      leaderId: state.id,
      prevLogIndex,
      prevLogTerm: entryAt(state.log, prevLogIndex)?.term ?? 0,
      entries: entriesFrom(state.log, nextIdx),
      leaderCommit: state.commitIndex,
    },
  }
}

function appendReply(
  state: NodeState,
  to: NodeId,
  success: boolean,
  matchIndex: number,
): Message {
  return {
    from: state.id,
    to,
    rpc: { type: 'append-entries-res', term: state.currentTerm, success, matchIndex },
  }
}

/**
 * Reply to a stale request with our own term.
 *
 * A stale *response* gets no reply — it is a straggler from an RPC this node
 * issued in an earlier term, and there is nothing to answer. Acting on it would
 * let a previous election's vote count toward the current one.
 */
function reject(state: NodeState, message: Message): Message[] {
  const { rpc } = message
  const to: NodeId = message.from

  switch (rpc.type) {
    case 'request-vote-req':
      return [
        {
          from: state.id,
          to,
          rpc: { type: 'request-vote-res', term: state.currentTerm, voteGranted: false },
        },
      ]

    case 'append-entries-req':
      return [appendReply(state, to, false, 0)]

    case 'request-vote-res':
    case 'append-entries-res':
      return []
  }
}
