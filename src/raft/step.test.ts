import { describe, expect, it } from 'vitest'

import { step } from './step'
import type { Message, NodeId, NodeState } from './types'

const SELF: NodeId = 'n1'
const PEERS: NodeId[] = ['n2', 'n3', 'n4', 'n5']

function node(overrides: Partial<NodeState> = {}): NodeState {
  return {
    id: SELF,
    peers: PEERS,
    role: 'follower',
    currentTerm: 5,
    votedFor: null,
    log: [],
    commitIndex: 0,
    lastApplied: 0,
    electionDeadline: 100,
    votesGranted: [],
    nextIndex: {},
    matchIndex: {},
    ...overrides,
  }
}

function voteReq(term: number, from: NodeId = 'n2'): Message {
  return {
    from,
    to: SELF,
    rpc: { type: 'request-vote-req', term, candidateId: from, lastLogIndex: 0, lastLogTerm: 0 },
  }
}

function voteRes(term: number, voteGranted: boolean, from: NodeId = 'n2'): Message {
  return { from, to: SELF, rpc: { type: 'request-vote-res', term, voteGranted } }
}

function appendReq(term: number, from: NodeId = 'n2'): Message {
  return {
    from,
    to: SELF,
    rpc: {
      type: 'append-entries-req',
      term,
      leaderId: from,
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    },
  }
}

function appendRes(term: number, success: boolean, from: NodeId = 'n2'): Message {
  return { from, to: SELF, rpc: { type: 'append-entries-res', term, success } }
}

function deliver(state: NodeState, message: Message) {
  return step(state, { type: 'deliver', message })
}

// Figure 2, Rules for Servers / All Servers:
//   "If RPC request or response contains term T > currentTerm:
//    set currentTerm = T, convert to follower."
// votedFor is per-term, so it clears with the term change.
describe('higher term forces a step down', () => {
  it('updates currentTerm from a RequestVote request', () => {
    const { state } = deliver(node({ currentTerm: 5 }), voteReq(7))

    expect(state.currentTerm).toBe(7)
    expect(state.role).toBe('follower')
  })

  it('clears a vote cast in the older term', () => {
    const before = node({ currentTerm: 5, votedFor: 'n3' })

    const { state } = deliver(before, voteReq(6, 'n4'))

    expect(state.currentTerm).toBe(6)
    expect(state.votedFor).toBeNull()
  })

  it('demotes a leader that sees a higher term', () => {
    const leader = node({
      role: 'leader',
      currentTerm: 5,
      votedFor: SELF,
      nextIndex: { n2: 1, n3: 1, n4: 1, n5: 1 },
      matchIndex: { n2: 0, n3: 0, n4: 0, n5: 0 },
    })

    const { state } = deliver(leader, appendReq(6, 'n2'))

    expect(state.role).toBe('follower')
    expect(state.currentTerm).toBe(6)
    expect(state.votedFor).toBeNull()
  })

  it('demotes a candidate and discards the votes it had collected', () => {
    const candidate = node({
      role: 'candidate',
      currentTerm: 5,
      votedFor: SELF,
      votesGranted: [SELF, 'n2'],
    })

    const { state } = deliver(candidate, voteReq(6, 'n3'))

    expect(state.role).toBe('follower')
    expect(state.votesGranted).toEqual([])
  })

  // The clause says "request or response". A leader that only inspects requests
  // keeps heartbeating alongside a newer-term leader, breaking Election Safety.
  it('steps down on a higher term carried by a RequestVote response', () => {
    const candidate = node({ role: 'candidate', currentTerm: 5, votedFor: SELF })

    const { state } = deliver(candidate, voteRes(9, false))

    expect(state.role).toBe('follower')
    expect(state.currentTerm).toBe(9)
    expect(state.votedFor).toBeNull()
  })

  it('steps down on a higher term carried by an AppendEntries response', () => {
    const leader = node({ role: 'leader', currentTerm: 5, votedFor: SELF })

    const { state } = deliver(leader, appendRes(8, false))

    expect(state.role).toBe('follower')
    expect(state.currentTerm).toBe(8)
    expect(state.votedFor).toBeNull()
  })
})

// Figure 2, Rules for Servers / All Servers:
//   "If RPC has term < currentTerm, reject it and reply with currentTerm."
// The reply is how the stale sender learns to step down.
describe('stale term is rejected', () => {
  it('replies to a stale RequestVote with voteGranted false and its own term', () => {
    const { state, outbox } = deliver(node({ currentTerm: 5 }), voteReq(3, 'n2'))

    expect(outbox).toEqual([
      {
        from: SELF,
        to: 'n2',
        rpc: { type: 'request-vote-res', term: 5, voteGranted: false },
      },
    ])
    expect(state.currentTerm).toBe(5)
  })

  it('replies to a stale AppendEntries with success false and its own term', () => {
    const { state, outbox } = deliver(node({ currentTerm: 5 }), appendReq(4, 'n3'))

    expect(outbox).toEqual([
      {
        from: SELF,
        to: 'n3',
        rpc: { type: 'append-entries-res', term: 5, success: false },
      },
    ])
    expect(state.currentTerm).toBe(5)
  })

  it('does not disturb a leader that receives a stale request', () => {
    const leader = node({ role: 'leader', currentTerm: 5, votedFor: SELF })

    const { state } = deliver(leader, appendReq(2, 'n4'))

    expect(state.role).toBe('leader')
    expect(state.currentTerm).toBe(5)
    expect(state.votedFor).toBe(SELF)
  })

  // A stale response is a straggler from an RPC this node sent in an earlier
  // term. There is nothing to reply to, and counting it would let an old
  // election's vote land in the current one.
  it('drops a stale RequestVote response without replying', () => {
    const candidate = node({ role: 'candidate', currentTerm: 5, votesGranted: [SELF] })

    const { state, outbox } = deliver(candidate, voteRes(3, true))

    expect(outbox).toEqual([])
    expect(state.votesGranted).toEqual([SELF])
    expect(state.currentTerm).toBe(5)
  })

  it('drops a stale AppendEntries response without replying', () => {
    const leader = node({ role: 'leader', currentTerm: 5 })

    const { outbox } = deliver(leader, appendRes(4, true))

    expect(outbox).toEqual([])
  })
})

// The step-down trigger is strictly greater-than. An equal term means the
// sender is a peer in the term this node is already in; a vote already cast in
// that term must survive, or the node could vote twice in one term and elect
// two leaders.
describe('equal term is not a step down', () => {
  it('keeps a vote already cast in the current term', () => {
    const before = node({ currentTerm: 5, votedFor: 'n3' })

    const { state } = deliver(before, voteReq(5, 'n4'))

    expect(state.currentTerm).toBe(5)
    expect(state.votedFor).toBe('n3')
  })
})

describe('step does not mutate its input', () => {
  it('returns a new state object and leaves the original untouched', () => {
    const before = node({ role: 'leader', currentTerm: 5, votedFor: SELF })
    const snapshot = structuredClone(before)

    const { state } = deliver(before, appendReq(6, 'n2'))

    expect(before).toEqual(snapshot)
    expect(state).not.toBe(before)
  })
})
