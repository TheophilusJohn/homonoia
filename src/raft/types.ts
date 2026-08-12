/**
 * Core types for the Raft state machine.
 *
 * This module is pure data. No I/O, no timers, no randomness — see CLAUDE.md.
 *
 * Log indices are 1-based, as in Figure 2 ("first index is 1"). The log is
 * stored as a dense array, so the entry at Raft index `i` is `log[i - 1]` and
 * the last log index is `log.length`. Index 0 denotes "no entry" and is the
 * base case for `prevLogIndex` / `commitIndex`.
 */

export type NodeId = string

export type Role = 'follower' | 'candidate' | 'leader'

/** An opaque client command, replicated verbatim. */
export type Command = string

export interface LogEntry {
  /** Term of the leader that created this entry. */
  readonly term: number
  readonly command: Command
}

export interface NodeState {
  readonly id: NodeId
  /** The other four nodes. Never includes `id`. */
  readonly peers: readonly NodeId[]
  readonly role: Role

  // --- Persistent state (survives a crash; intact on revive) ---

  /** Latest term seen. Starts at 0, only ever increases. */
  readonly currentTerm: number
  /** Candidate voted for in `currentTerm`, or null. Cleared whenever the term advances. */
  readonly votedFor: NodeId | null
  readonly log: readonly LogEntry[]

  // --- Volatile state, all servers (cleared on revive) ---

  readonly commitIndex: number
  readonly lastApplied: number
  /** Virtual-clock time at which this node starts an election. */
  readonly electionDeadline: number

  // --- Volatile state, candidates ---

  /** Peers that granted a vote in `currentTerm`, plus self. */
  readonly votesGranted: readonly NodeId[]

  // --- Volatile state, leaders (reinitialized after every election) ---

  /** Optimistic guess per follower; walked back on rejection. Never used for commit. */
  readonly nextIndex: Readonly<Record<NodeId, number>>
  /** Confirmed replication high-water mark per follower. The commit calculation reads this. */
  readonly matchIndex: Readonly<Record<NodeId, number>>
}

// --- RPCs ---

export interface RequestVoteRequest {
  readonly type: 'request-vote-req'
  readonly term: number
  readonly candidateId: NodeId
  readonly lastLogIndex: number
  readonly lastLogTerm: number
}

export interface RequestVoteResponse {
  readonly type: 'request-vote-res'
  readonly term: number
  readonly voteGranted: boolean
}

export interface AppendEntriesRequest {
  readonly type: 'append-entries-req'
  readonly term: number
  readonly leaderId: NodeId
  readonly prevLogIndex: number
  readonly prevLogTerm: number
  /** Empty for a heartbeat, which still runs the full consistency check. */
  readonly entries: readonly LogEntry[]
  readonly leaderCommit: number
}

export interface AppendEntriesResponse {
  readonly type: 'append-entries-res'
  readonly term: number
  readonly success: boolean
}

export type Rpc =
  | RequestVoteRequest
  | RequestVoteResponse
  | AppendEntriesRequest
  | AppendEntriesResponse

/** An RPC in transit. The driver owns delivery, delay, drop and duplication. */
export interface Message {
  readonly from: NodeId
  readonly to: NodeId
  readonly rpc: Rpc
}

// --- Events ---

/**
 * Time entering the core. `now` is the driver's virtual clock in tick units.
 *
 * `randomElectionTimeout` is a fresh draw from the driver's seeded PRNG, offered
 * on every tick and consumed only if the node resets its election timer this
 * tick. This is how randomized election timeouts reach a core that is forbidden
 * from generating randomness of its own.
 */
export interface TickEvent {
  readonly type: 'tick'
  readonly now: number
  readonly randomElectionTimeout: number
}

/** Delivery of a message addressed to this node. */
export interface DeliverEvent {
  readonly type: 'deliver'
  readonly message: Message
}

/** A client submitting a command. Only a leader acts on it. */
export interface ClientCommandEvent {
  readonly type: 'client-command'
  readonly command: Command
}

export type Event = TickEvent | DeliverEvent | ClientCommandEvent

export interface StepResult {
  readonly state: NodeState
  readonly outbox: Message[]
}

/**
 * The whole core: a pure function from (state, event) to (new state, messages
 * to send). It never mutates `state` and never performs I/O.
 */
export type Step = (state: NodeState, event: Event) => StepResult
