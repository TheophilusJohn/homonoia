import { describe, expect, it } from 'vitest'

import type { NodeId } from '../raft/types'
import { allNodes, createSim, leaders } from '../sim/sim'
import type { SimOptions } from '../sim/sim'
import { runChecked } from './invariants'

const NODES: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

function options(overrides: Partial<SimOptions> = {}): SimOptions {
  return {
    seed: 4242,
    nodes: NODES,
    latency: { min: 1, max: 4 },
    electionTimeout: { min: 150, max: 300 },
    ...overrides,
  }
}

describe('a healthy cluster elects exactly one leader', () => {
  it('has no leader before the shortest possible timeout has elapsed', () => {
    const sim = createSim(options())

    runChecked(sim, 149)

    expect(leaders(sim)).toHaveLength(0)
  })

  it('settles on exactly one leader', () => {
    const sim = createSim(options())

    runChecked(sim, 1000)

    expect(leaders(sim)).toHaveLength(1)
  })

  it('keeps that leader across a long quiet run', () => {
    const sim = createSim(options())
    runChecked(sim, 1000)
    const elected = leaders(sim)[0].id

    const seen = new Set<NodeId>()
    for (let i = 0; i < 2000; i++) {
      runChecked(sim, 1)
      for (const leader of leaders(sim)) seen.add(leader.id)
    }

    expect([...seen]).toEqual([elected])
  })

  // Heartbeats are the only reason the followers stay quiet. If they stopped,
  // the shortest follower timeout would fire and the term would climb.
  it('holds every node in the same term once settled', () => {
    const sim = createSim(options())

    runChecked(sim, 2000)

    const terms = new Set(allNodes(sim).map((node) => node.currentTerm))
    expect(terms.size).toBe(1)
  })

  it('leaves every other node a follower that voted for the winner', () => {
    const sim = createSim(options())
    runChecked(sim, 1000)
    const elected = leaders(sim)[0]

    for (const node of allNodes(sim)) {
      if (node.id === elected.id) continue
      expect(node.role).toBe('follower')
      expect(node.votedFor).toBe(elected.id)
    }
  })
})

describe('split vote', () => {
  // Four nodes and a degenerate timeout range, so every node draws exactly the
  // same timeout and they contend in perfect lockstep. A majority of four is
  // three; four self-votes elect nobody.
  const lockstep = options({
    nodes: ['n1', 'n2', 'n3', 'n4'],
    electionTimeout: { min: 150, max: 150 },
  })

  it('elects nobody in the contested term', () => {
    const sim = createSim(lockstep)

    runChecked(sim, 150)

    expect(leaders(sim)).toHaveLength(0)
    for (const node of allNodes(sim)) {
      expect(node.role).toBe('candidate')
      expect(node.currentTerm).toBe(1)
      expect(node.votedFor).toBe(node.id)
      expect(node.votesGranted).toEqual([node.id])
    }
  })

  // This is what the randomization in Figure 2 exists to prevent. With
  // identical timeouts the tie re-forms at the same instant, every time, and
  // the cluster burns terms forever without ever electing anyone.
  it('livelocks forever when the timeout is not randomized', () => {
    const sim = createSim(lockstep)

    runChecked(sim, 1500)

    expect(leaders(sim)).toHaveLength(0)
    // One failed election per timeout period, terms climbing the whole way.
    expect(allNodes(sim)[0].currentTerm).toBeGreaterThan(5)
  })

  it('resolves as soon as the timeout is drawn from a range', () => {
    const sim = createSim(
      options({ nodes: ['n1', 'n2', 'n3', 'n4'], electionTimeout: { min: 150, max: 300 } }),
    )

    runChecked(sim, 1500)

    expect(leaders(sim)).toHaveLength(1)
  })
})
