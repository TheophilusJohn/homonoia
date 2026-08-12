import { describe, expect, it } from 'vitest'

import { leaders, makeCluster, node, run, submit } from '../test/cluster'
import { step } from './step'
import type { AppendEntriesResponse, LogEntry, Message, NodeId, NodeState } from './types'

const SELF: NodeId = 'n1'

function entry(term: number, key: string, value = key.toUpperCase()): LogEntry {
  return { term, command: { key, value } }
}

function nodeState(overrides: Partial<NodeState> = {}): NodeState {
  return {
    id: SELF,
    peers: ['n2', 'n3', 'n4', 'n5'],
    role: 'follower',
    currentTerm: 5,
    votedFor: null,
    log: [],
    commitIndex: 0,
    lastApplied: 0,
    kv: {},
    electionElapsed: 0,
    electionTimeout: 150,
    heartbeatElapsed: 0,
    votesGranted: [],
    nextIndex: {},
    matchIndex: {},
    ...overrides,
  }
}

function appendReq(
  overrides: Partial<{
    term: number
    from: NodeId
    prevLogIndex: number
    prevLogTerm: number
    entries: LogEntry[]
    leaderCommit: number
  }> = {},
): Message {
  const {
    term = 5,
    from = 'n2',
    prevLogIndex = 0,
    prevLogTerm = 0,
    entries = [],
    leaderCommit = 0,
  } = overrides

  return {
    from,
    to: SELF,
    rpc: {
      type: 'append-entries-req',
      term,
      leaderId: from,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit,
    },
  }
}

function appendRes(
  term: number,
  success: boolean,
  matchIndex: number,
  from: NodeId = 'n2',
): Message {
  return { from, to: SELF, rpc: { type: 'append-entries-res', term, success, matchIndex } }
}

function deliver(state: NodeState, message: Message) {
  return step(state, { type: 'deliver', message })
}

function replyTo(result: { outbox: Message[] }): AppendEntriesResponse {
  const rpc = result.outbox[0]?.rpc
  if (rpc?.type !== 'append-entries-res') throw new Error('expected an AppendEntries response')
  return rpc
}

// Figure 2, AppendEntries receiver 2: "Reply false if log doesn't contain an
// entry at prevLogIndex whose term matches prevLogTerm."
describe('consistency check', () => {
  const log = [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')]

  it('accepts an empty log at the base case, prevLogIndex 0', () => {
    expect(replyTo(deliver(nodeState({ log: [] }), appendReq())).success).toBe(true)
  })

  it('accepts when the entry at prevLogIndex matches in term', () => {
    const result = deliver(nodeState({ log }), appendReq({ prevLogIndex: 2, prevLogTerm: 2 }))

    expect(replyTo(result).success).toBe(true)
  })

  it('rejects when the term at prevLogIndex differs', () => {
    const result = deliver(nodeState({ log }), appendReq({ prevLogIndex: 2, prevLogTerm: 9 }))

    expect(replyTo(result).success).toBe(false)
  })

  it('rejects when the log is too short to have prevLogIndex at all', () => {
    const result = deliver(nodeState({ log }), appendReq({ prevLogIndex: 7, prevLogTerm: 3 }))

    expect(replyTo(result).success).toBe(false)
  })

  it('changes nothing about the log when it rejects', () => {
    const before = nodeState({ log })

    const { state } = deliver(before, appendReq({ prevLogIndex: 2, prevLogTerm: 9, entries: [entry(5, 'z')] }))

    expect(state.log).toEqual(log)
  })

  it('never reports success while failing the check, whatever it carries', () => {
    // Every shape of request that fails the check must fail, entries or not.
    const bad = [
      appendReq({ prevLogIndex: 1, prevLogTerm: 99 }),
      appendReq({ prevLogIndex: 3, prevLogTerm: 1, entries: [entry(5, 'z')] }),
      appendReq({ prevLogIndex: 4, prevLogTerm: 3 }),
      appendReq({ prevLogIndex: 99, prevLogTerm: 3, leaderCommit: 3 }),
    ]

    for (const request of bad) {
      expect(replyTo(deliver(nodeState({ log }), request)).success).toBe(false)
    }
  })
})

// Figure 2, AppendEntries receiver 3 and 4.
describe('conflict truncation and append', () => {
  it('appends entries past the end of the log', () => {
    const before = nodeState({ log: [entry(1, 'a')] })

    const { state } = deliver(
      before,
      appendReq({ prevLogIndex: 1, prevLogTerm: 1, entries: [entry(5, 'b'), entry(5, 'c')] }),
    )

    expect(state.log).toEqual([entry(1, 'a'), entry(5, 'b'), entry(5, 'c')])
  })

  it('replaces a conflicting entry and everything after it', () => {
    const before = nodeState({ log: [entry(1, 'a'), entry(2, 'x'), entry(2, 'y'), entry(2, 'z')] })

    const { state } = deliver(
      before,
      appendReq({ prevLogIndex: 1, prevLogTerm: 1, entries: [entry(5, 'b')] }),
    )

    // x conflicts at index 2, so y and z go with it even though nothing was
    // sent to replace them.
    expect(state.log).toEqual([entry(1, 'a'), entry(5, 'b')])
  })

  // The subtle one. A duplicate of an earlier AppendEntries arrives after the
  // follower has moved on. Every entry it carries is already present and
  // matching, so clause 3 must not fire. Truncating here would delete entries
  // the leader still counts in matchIndex — and if the leader had already
  // committed them on the strength of that count, this follower would be left
  // able to vote while missing committed entries.
  it('leaves the log alone when a delayed duplicate carries matching entries', () => {
    const log = [entry(1, 'a'), entry(1, 'b'), entry(2, 'c'), entry(2, 'd')]
    const before = nodeState({ log, commitIndex: 4, lastApplied: 4 })

    const { state } = deliver(
      before,
      appendReq({ prevLogIndex: 1, prevLogTerm: 1, entries: [entry(1, 'b'), entry(2, 'c')] }),
    )

    expect(state.log).toEqual(log)
    expect(state.commitIndex).toBe(4)
  })

  it('keeps the matching prefix and truncates only from the first real conflict', () => {
    const before = nodeState({ log: [entry(1, 'a'), entry(1, 'b'), entry(2, 'c'), entry(2, 'd')] })

    const { state } = deliver(
      before,
      appendReq({
        prevLogIndex: 1,
        prevLogTerm: 1,
        // b matches, c conflicts at index 3.
        entries: [entry(1, 'b'), entry(5, 'C'), entry(5, 'D')],
      }),
    )

    expect(state.log).toEqual([entry(1, 'a'), entry(1, 'b'), entry(5, 'C'), entry(5, 'D')])
  })

  it('is idempotent — the same request twice leaves the same log', () => {
    const request = appendReq({ prevLogIndex: 0, prevLogTerm: 0, entries: [entry(5, 'a'), entry(5, 'b')] })

    const once = deliver(nodeState({ log: [] }), request).state
    const twice = deliver(once, request).state

    expect(twice.log).toEqual(once.log)
    expect(twice.log).toHaveLength(2)
  })
})

// Figure 2, AppendEntries receiver 5.
describe('follower commit and apply', () => {
  it('commits up to leaderCommit and applies in index order', () => {
    const before = nodeState({ log: [] })

    const { state } = deliver(
      before,
      appendReq({
        entries: [entry(5, 'a', 'first'), entry(5, 'b', 'second')],
        leaderCommit: 2,
      }),
    )

    expect(state.commitIndex).toBe(2)
    expect(state.lastApplied).toBe(2)
    expect(state.kv).toEqual({ a: 'first', b: 'second' })
  })

  it('never commits past the last entry the message actually carried', () => {
    // The leader has committed 9, but this request only brings us to index 1.
    const { state } = deliver(
      nodeState({ log: [] }),
      appendReq({ entries: [entry(5, 'a')], leaderCommit: 9 }),
    )

    expect(state.commitIndex).toBe(1)
  })

  it('does not move commitIndex backwards on a delayed message', () => {
    const before = nodeState({
      log: [entry(1, 'a'), entry(1, 'b'), entry(1, 'c')],
      commitIndex: 3,
      lastApplied: 3,
    })

    // A straggler that only covers index 1, with a leaderCommit above ours.
    const { state } = deliver(
      before,
      appendReq({ prevLogIndex: 0, prevLogTerm: 0, entries: [entry(1, 'a')], leaderCommit: 4 }),
    )

    expect(state.commitIndex).toBe(3)
  })

  it('applies a later value over an earlier one for the same key', () => {
    const { state } = deliver(
      nodeState({ log: [] }),
      appendReq({
        entries: [entry(5, 'k', 'old'), entry(5, 'k', 'new')],
        leaderCommit: 2,
      }),
    )

    expect(state.kv).toEqual({ k: 'new' })
  })

  it('reports how far it got, so the leader can set matchIndex', () => {
    const result = deliver(
      nodeState({ log: [entry(1, 'a')] }),
      appendReq({ prevLogIndex: 1, prevLogTerm: 1, entries: [entry(5, 'b'), entry(5, 'c')] }),
    )

    expect(replyTo(result)).toMatchObject({ success: true, matchIndex: 3 })
  })
})

describe('leader handling of AppendEntries responses', () => {
  function leader(overrides: Partial<NodeState> = {}): NodeState {
    return nodeState({
      role: 'leader',
      currentTerm: 5,
      log: [entry(5, 'a'), entry(5, 'b'), entry(5, 'c')],
      nextIndex: { n2: 4, n3: 4, n4: 4, n5: 4 },
      matchIndex: { n2: 0, n3: 0, n4: 0, n5: 0 },
      ...overrides,
    })
  }

  it('advances matchIndex and nextIndex on success', () => {
    const { state } = deliver(leader(), appendRes(5, true, 3, 'n2'))

    expect(state.matchIndex.n2).toBe(3)
    expect(state.nextIndex.n2).toBe(4)
  })

  it('never lets a reordered response drag matchIndex backwards', () => {
    const ahead = leader({ matchIndex: { n2: 3, n3: 0, n4: 0, n5: 0 } })

    const { state } = deliver(ahead, appendRes(5, true, 1, 'n2'))

    expect(state.matchIndex.n2).toBe(3)
  })

  // The two reasons a follower says false, which must not be confused.
  describe('failure', () => {
    it('walks nextIndex back and retries when the term is our own', () => {
      const { state, outbox } = deliver(leader(), appendRes(5, false, 0, 'n2'))

      expect(state.role).toBe('leader')
      expect(state.nextIndex.n2).toBe(3)

      // The retry carries the earlier prevLogIndex, so it can find the match.
      expect(outbox).toHaveLength(1)
      expect(outbox[0].to).toBe('n2')
      expect(outbox[0].rpc).toMatchObject({ type: 'append-entries-req', prevLogIndex: 2 })
    })

    it('keeps walking back on repeated rejections', () => {
      let state = leader()
      for (let i = 0; i < 3; i++) {
        state = deliver(state, appendRes(5, false, 0, 'n2')).state
      }

      expect(state.nextIndex.n2).toBe(1)
    })

    it('never walks nextIndex below 1', () => {
      let state = leader({ nextIndex: { n2: 1, n3: 4, n4: 4, n5: 4 } })
      for (let i = 0; i < 5; i++) {
        state = deliver(state, appendRes(5, false, 0, 'n2')).state
      }

      expect(state.nextIndex.n2).toBe(1)
    })

    it('steps down instead of retrying when the term is higher', () => {
      const { state, outbox } = deliver(leader(), appendRes(6, false, 0, 'n2'))

      expect(state.role).toBe('follower')
      expect(state.currentTerm).toBe(6)
      expect(state.votedFor).toBeNull()
      // No retry: we are not the leader any more.
      expect(outbox).toEqual([])
    })

    it('does not touch nextIndex when it steps down', () => {
      const { state } = deliver(leader(), appendRes(6, false, 0, 'n2'))

      // Leader volatile state is dropped wholesale, not decremented.
      expect(state.nextIndex).toEqual({})
      expect(state.matchIndex).toEqual({})
    })
  })
})

describe('commit advancement', () => {
  function leader(overrides: Partial<NodeState> = {}): NodeState {
    return nodeState({ role: 'leader', currentTerm: 5, ...overrides })
  }

  it('commits an entry from the current term once a majority holds it', () => {
    const before = leader({
      log: [entry(5, 'a'), entry(5, 'b')],
      matchIndex: { n2: 0, n3: 0, n4: 0, n5: 0 },
    })

    // Two peers plus the leader itself is three of five.
    const first = deliver(before, appendRes(5, true, 2, 'n2')).state
    const { state } = deliver(first, appendRes(5, true, 2, 'n3'))

    expect(state.commitIndex).toBe(2)
    expect(state.lastApplied).toBe(2)
  })

  it('does not commit on a minority', () => {
    const before = leader({
      log: [entry(5, 'a')],
      matchIndex: { n2: 0, n3: 0, n4: 0, n5: 0 },
    })

    const { state } = deliver(before, appendRes(5, true, 1, 'n2'))

    expect(state.commitIndex).toBe(0)
  })

  // --- The Figure 8 restriction ---
  //
  // Remove `log[N].term === currentTerm` from advanceCommit and the first of
  // these two tests fails: the leader commits an index that a later leader can
  // still legally overwrite, and a client is told a write is durable that is
  // not.
  describe('the current-term restriction (Figure 8)', () => {
    // Figure 8 (c): S1 is leader again in term 4. The entry at index 2 is from
    // term 2 — its original term — and S1 has just finished pushing it out to a
    // majority. Index 3 is S1's own term-4 entry, still only on itself.
    const figure8 = leader({
      currentTerm: 4,
      log: [entry(1, 'a'), entry(2, 'b'), entry(4, 'c')],
      commitIndex: 1,
      lastApplied: 1,
      kv: { a: 'A' },
      matchIndex: { n2: 2, n3: 0, n4: 0, n5: 0 },
    })

    it('refuses to commit an entry from an earlier term on a majority', () => {
      // n3's success puts index 2 on n1, n2, n3 — a clear majority of five.
      const { state } = deliver(figure8, appendRes(4, true, 2, 'n3'))

      // A majority holds index 2, and it is still not committed, because
      // log[2].term is 2 and we are in term 4. S5 can still win term 5 with a
      // term-3 log and overwrite this index.
      expect(state.matchIndex).toMatchObject({ n2: 2, n3: 2 })
      expect(state.commitIndex).toBe(1)
      expect(state.kv).toEqual({ a: 'A' })
    })

    it('commits the inherited entry indirectly, once a current-term entry commits', () => {
      // Same cluster, but now the followers have taken index 3 as well — the
      // leader's own term-4 entry.
      const withIndex3 = deliver(figure8, appendRes(4, true, 3, 'n3')).state
      const { state } = deliver(withIndex3, appendRes(4, true, 3, 'n2'))

      // Committing index 3 carries indices 1 and 2 with it: Log Matching says
      // a majority holding index 3 holds everything before it too.
      expect(state.commitIndex).toBe(3)
      expect(state.lastApplied).toBe(3)
      expect(state.kv).toEqual({ a: 'A', b: 'B', c: 'C' })
    })

    it('still commits nothing when only old-term entries reach every node', () => {
      const allOldTerm = leader({
        currentTerm: 9,
        log: [entry(2, 'a'), entry(2, 'b')],
        matchIndex: { n2: 2, n3: 2, n4: 2, n5: 2 },
      })

      // Everyone has everything, and none of it is committable, because a
      // term-9 leader has not yet appended anything of its own.
      const { state } = deliver(allOldTerm, appendRes(9, true, 2, 'n2'))

      expect(state.commitIndex).toBe(0)
    })
  })
})

describe('end to end replication', () => {
  const timeouts = { n1: 150, n2: 200, n3: 250 }
  const draws = { n1: 160, n2: 210, n3: 260 }

  function electedCluster() {
    const cluster = makeCluster(timeouts)
    run(cluster, 200, draws)
    expect(leaders(cluster)).toHaveLength(1)
    return cluster
  }

  it('replicates a command to every node and applies it everywhere', () => {
    const cluster = electedCluster()

    submit(cluster, { key: 'colour', value: 'blue' })
    run(cluster, 100, draws)

    for (const n of cluster.nodes.values()) {
      expect(n.log).toHaveLength(1)
      expect(n.commitIndex).toBe(1)
      expect(n.kv).toEqual({ colour: 'blue' })
    }
  })

  it('keeps every log identical across a stream of commands', () => {
    const cluster = electedCluster()

    for (let i = 1; i <= 20; i++) {
      submit(cluster, { key: `k${i}`, value: `v${i}` })
      run(cluster, 5, draws)
    }
    run(cluster, 100, draws)

    const [first, ...rest] = [...cluster.nodes.values()]
    for (const n of rest) {
      expect(n.log).toEqual(first.log)
      expect(n.commitIndex).toBe(first.commitIndex)
      expect(n.kv).toEqual(first.kv)
    }
    expect(first.log).toHaveLength(20)
    expect(first.commitIndex).toBe(20)
  })

  it('applies overwrites in log order, so every node agrees on the last value', () => {
    const cluster = electedCluster()

    for (const value of ['one', 'two', 'three']) {
      submit(cluster, { key: 'k', value })
      run(cluster, 5, draws)
    }
    run(cluster, 100, draws)

    for (const n of cluster.nodes.values()) {
      expect(n.kv).toEqual({ k: 'three' })
      expect(n.log).toHaveLength(3)
    }
  })

  it('ignores a command submitted to a follower', () => {
    const cluster = electedCluster()
    const follower = node(cluster, 'n2')

    const { state, outbox } = step(follower, {
      type: 'client-command',
      command: { key: 'k', value: 'v' },
    })

    expect(state.log).toEqual([])
    expect(outbox).toEqual([])
  })

  it('leaves lastApplied tracking commitIndex on every node', () => {
    const cluster = electedCluster()

    for (let i = 1; i <= 5; i++) {
      submit(cluster, { key: `k${i}`, value: `v${i}` })
      run(cluster, 20, draws)
    }

    for (const n of cluster.nodes.values()) {
      expect(n.lastApplied).toBe(n.commitIndex)
      expect(Object.keys(n.kv)).toHaveLength(5)
    }
  })
})
