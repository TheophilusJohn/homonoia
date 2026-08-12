import type { Event, Message, NodeState, StepResult } from './types'

/**
 * The Raft core.
 *
 * Pure: same (state, event) always yields the same result, no I/O, no clock, no
 * randomness, input never mutated. The driver routes `outbox` and decides when
 * the next event arrives.
 *
 * Milestone 1 implements the term rules from Figure 2's "Rules for Servers /
 * All Servers" only. Election and replication handling are stubbed and land in
 * milestones 2 and 3.
 */
export function step(state: NodeState, event: Event): StepResult {
  switch (event.type) {
    case 'tick':
      // Milestone 2: election timeout, becoming candidate, leader heartbeats.
      return { state, outbox: [] }

    case 'client-command':
      // Milestone 3: a leader appends to its log and replicates.
      return { state, outbox: [] }

    case 'deliver':
      return deliver(state, event.message)
  }
}

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
    case 'request-vote-req':
      // Milestone 2: the up-to-date log comparison, then grant or deny.
      return { state: current, outbox: [] }

    case 'request-vote-res':
      // Milestone 2: vote counting, majority check, becoming leader.
      return { state: current, outbox: [] }

    case 'append-entries-req':
      // Milestone 3: consistency check, truncation, append, commit advance.
      return { state: current, outbox: [] }

    case 'append-entries-res':
      // Milestone 3: nextIndex / matchIndex update, commit advance.
      return { state: current, outbox: [] }
  }
}

/**
 * Adopt a newer term and revert to follower.
 *
 * `votedFor` is scoped to a single term, so advancing the term clears it —
 * otherwise the node would enter the new term believing it had already voted
 * and would refuse every candidate. Candidate and leader volatile state is
 * dropped for the same reason: it belonged to the term being left behind.
 */
function stepDown(state: NodeState, term: number): NodeState {
  return {
    ...state,
    role: 'follower',
    currentTerm: term,
    votedFor: null,
    votesGranted: [],
    nextIndex: {},
    matchIndex: {},
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

  switch (rpc.type) {
    case 'request-vote-req':
      return [
        {
          from: state.id,
          to: message.from,
          rpc: { type: 'request-vote-res', term: state.currentTerm, voteGranted: false },
        },
      ]

    case 'append-entries-req':
      return [
        {
          from: state.id,
          to: message.from,
          rpc: { type: 'append-entries-res', term: state.currentTerm, success: false },
        },
      ]

    case 'request-vote-res':
    case 'append-entries-res':
      return []
  }
}
