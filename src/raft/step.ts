import { entryAt, lastLogIndex, lastLogTerm } from './log'
import type {
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
 * Milestone 2 implements the term rules and leader election. Log replication
 * (AppendEntries receiver clauses 2-5, nextIndex/matchIndex advancement, commit)
 * is milestone 3 and is stubbed.
 */
export function step(state: NodeState, event: Event): StepResult {
  switch (event.type) {
    case 'tick':
      return tick(state, event)

    case 'client-command':
      // Milestone 3: a leader appends to its log and replicates.
      return { state, outbox: [] }

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
    return { state: beating, outbox: heartbeats(beating) }
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

    case 'append-entries-req': {
      // Figure 2, Candidates: "If AppendEntries RPC received from new leader:
      // convert to follower." Reaching here means the term is equal to ours —
      // higher was handled above, lower was rejected — so the sender is the
      // legitimate leader of this term and the election timer resets.
      const follower: NodeState = {
        ...current,
        role: 'follower',
        electionElapsed: 0,
        votesGranted: [],
      }

      // Milestone 3: AppendEntries receiver clauses 2-5 (consistency check,
      // conflict truncation, append, commit advance). Until replication exists
      // every log is empty and prevLogIndex is always 0, so the consistency
      // check this replaces would pass unconditionally anyway.
      return {
        state: follower,
        outbox: [
          {
            from: follower.id,
            to: message.from,
            rpc: { type: 'append-entries-res', term: follower.currentTerm, success: true },
          },
        ],
      }
    }

    case 'append-entries-res':
      // Milestone 3: nextIndex / matchIndex update and commit advance. Nothing
      // to track until entries are actually being replicated.
      return { state: current, outbox: [] }
  }
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
 * out and contest the term it just conceded.
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
 * Figure 2, Candidates → Leaders, plus the leader volatile state
 * reinitialization: nextIndex optimistic at last log index + 1, matchIndex
 * pessimistic at 0.
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

  return { state: leader, outbox: heartbeats(leader) }
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

/**
 * Empty AppendEntries to every peer.
 *
 * `prevLogIndex` is derived per follower from `nextIndex`, which is already the
 * form milestone 3 needs; only `entries` stays empty here.
 */
function heartbeats(state: NodeState): Message[] {
  return state.peers.map((peer) => {
    const prevLogIndex = (state.nextIndex[peer] ?? lastLogIndex(state.log) + 1) - 1
    return {
      from: state.id,
      to: peer,
      rpc: {
        type: 'append-entries-req',
        term: state.currentTerm,
        leaderId: state.id,
        prevLogIndex,
        prevLogTerm: entryAt(state.log, prevLogIndex)?.term ?? 0,
        entries: [],
        leaderCommit: state.commitIndex,
      },
    }
  })
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
      return [
        {
          from: state.id,
          to,
          rpc: { type: 'append-entries-res', term: state.currentTerm, success: false },
        },
      ]

    case 'request-vote-res':
    case 'append-entries-res':
      return []
  }
}
