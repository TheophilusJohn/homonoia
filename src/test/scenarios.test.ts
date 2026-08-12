import { describe, expect, it } from 'vitest'

import type { LogEntry, NodeId } from '../raft/types'
import { allNodes, createSim, kill, leaders, liveNodes, nodeState, revive, submit } from '../sim/sim'
import type { Sim, SimOptions } from '../sim/sim'
import { runChecked } from './invariants'

/**
 * Named scenarios. Each one is a specific way the cluster can be attacked;
 * when a fuzz seed finds a new one in milestone 5, it gets a test here.
 */

const NODES: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

function options(overrides: Partial<SimOptions> = {}): SimOptions {
  return {
    seed: 20260811,
    nodes: NODES,
    latency: { min: 1, max: 4 },
    electionTimeout: { min: 150, max: 300 },
    ...overrides,
  }
}

function elected(overrides: Partial<SimOptions> = {}): Sim {
  const sim = createSim(options(overrides))
  runChecked(sim, 600)
  expect(leaders(sim)).toHaveLength(1)
  return sim
}

/** The entries a node considers committed. */
function committed(sim: Sim, id: NodeId): LogEntry[] {
  const node = nodeState(sim, id)
  return node.log.slice(0, node.commitIndex)
}

describe('leader killed mid-term', () => {
  function killTheLeader() {
    const sim = elected()

    for (let i = 1; i <= 5; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 40)
    }
    runChecked(sim, 300)

    const old = leaders(sim)[0]
    const committedBefore = committed(sim, old.id)
    expect(committedBefore).toHaveLength(5)

    kill(sim, old.id)
    runChecked(sim, 1500)

    return { sim, old, committedBefore }
  }

  it('elects a new leader from the survivors', () => {
    const { sim, old } = killTheLeader()

    const elected = leaders(sim)
    expect(elected).toHaveLength(1)
    expect(elected[0].id).not.toBe(old.id)
  })

  // Leader Completeness: an entry committed in a given term is present in the
  // log of every leader of every higher term. The new leader could only have
  // won with votes from a majority, and every majority contains a node holding
  // the committed entries, which the up-to-date check makes decisive.
  it('keeps every committed entry in the new leader log', () => {
    const { sim, committedBefore } = killTheLeader()
    const successor = leaders(sim)[0]

    expect(successor.log.slice(0, committedBefore.length)).toEqual(committedBefore)
  })

  it('keeps every committed entry on every surviving node', () => {
    const { sim, committedBefore } = killTheLeader()

    for (const node of liveNodes(sim)) {
      expect(node.log.slice(0, committedBefore.length)).toEqual(committedBefore)
      expect(node.commitIndex).toBeGreaterThanOrEqual(committedBefore.length)
    }
  })

  it('does not lose the applied values', () => {
    const { sim } = killTheLeader()

    for (const node of liveNodes(sim)) {
      expect(node.kv).toEqual({ k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5' })
    }
  })

  it('accepts new commands under the new leader', () => {
    const { sim, committedBefore } = killTheLeader()

    submit(sim, { key: 'after', value: 'crash' })
    runChecked(sim, 400)

    for (const node of liveNodes(sim)) {
      expect(node.commitIndex).toBe(committedBefore.length + 1)
      expect(node.kv.after).toBe('crash')
    }
  })

  it('brings the old leader back as a follower that catches up', () => {
    const { sim, old } = killTheLeader()

    submit(sim, { key: 'after', value: 'crash' })
    runChecked(sim, 200)
    revive(sim, old.id)
    runChecked(sim, 600)

    const restarted = nodeState(sim, old.id)
    expect(restarted.role).toBe('follower')
    expect(restarted.kv).toEqual(nodeState(sim, leaders(sim)[0].id).kv)
    expect(leaders(sim)).toHaveLength(1)
  })
})

describe('duplicated messages', () => {
  // Every single message is sent twice, each copy with its own latency draw, so
  // duplicates arrive interleaved with fresh traffic rather than back to back.
  const noisy = { duplicateProbability: 1 }

  it('duplicates are actually happening', () => {
    const sim = elected(noisy)

    expect(sim.bus.stats.duplicated).toBeGreaterThan(0)
  })

  it('does not append an entry twice', () => {
    const sim = elected(noisy)

    for (let i = 1; i <= 10; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 40)
    }
    runChecked(sim, 600)

    // Ten commands submitted, ten entries — not twenty.
    for (const node of allNodes(sim)) {
      expect(node.log).toHaveLength(10)
      expect(node.kv).toEqual(
        Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i + 1}`, `v${i + 1}`])),
      )
    }
  })

  it('does not let a duplicated vote response manufacture a majority', () => {
    // Every RequestVote response is doubled. Counting a voter twice would let
    // two granted votes look like four and elect two leaders in one term.
    const sim = createSim(options({ ...noisy, seed: 77 }))

    runChecked(sim, 2000)

    expect(leaders(sim)).toHaveLength(1)
  })

  // The dangerous duplicate is not the one that arrives immediately — it is the
  // one that arrives long after the follower has moved past the entries it
  // carries. A wide latency spread plus commands arriving faster than the
  // slowest message means a copy of an old AppendEntries lands when the
  // follower's log already extends well beyond it. A receiver that truncated
  // from prevLogIndex + 1 instead of only on a genuine term conflict deletes
  // committed entries here, and the committed-prefix invariant catches it on
  // the tick it happens.
  it('does not let a long-delayed duplicate truncate entries the follower has moved past', () => {
    const sim = elected({ duplicateProbability: 1, latency: { min: 1, max: 40 } })

    for (let i = 1; i <= 25; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 3)
    }
    runChecked(sim, 1200)

    const leader = leaders(sim)[0]
    expect(leader.log).toHaveLength(25)
    expect(leader.commitIndex).toBe(25)
    for (const node of allNodes(sim)) {
      expect(node.log).toEqual(leader.log)
    }
  })

  it('survives duplication and loss at the same time', () => {
    const sim = elected({ duplicateProbability: 1, dropProbability: 0.15 })

    for (let i = 1; i <= 8; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 40)
    }
    runChecked(sim, 2000)

    const [first, ...rest] = allNodes(sim)
    expect(first.log).toHaveLength(8)
    for (const node of rest) expect(node.log).toEqual(first.log)
  })
})
