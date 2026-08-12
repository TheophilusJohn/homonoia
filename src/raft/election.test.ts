import { describe, expect, it } from 'vitest'

import { leaders, makeCluster, node, run } from '../test/cluster'
import { HEARTBEAT_INTERVAL } from './step'
import type { NodeId } from './types'

describe('a healthy cluster elects exactly one leader', () => {
  // n1 has the shortest timeout, so it is the one that wakes up first. Nothing
  // fails and nothing is dropped, so this is the boring path — which is the
  // path that has to be rock solid before partitions are interesting.
  const timeouts = { n1: 150, n2: 200, n3: 250 }
  const draws = { n1: 160, n2: 210, n3: 260 }

  it('elects one leader and keeps it across many ticks', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 1000, draws)

    const elected = leaders(cluster)
    expect(elected).toHaveLength(1)
    expect(elected[0].id).toBe('n1')
  })

  it('nobody is leader before the first timeout elapses', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 149, draws)

    expect(leaders(cluster)).toHaveLength(0)
  })

  it('wins on a bare majority, without waiting for the last vote', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 150, draws)

    const leader = node(cluster, 'n1')
    expect(leader.role).toBe('leader')
    // Two of three: itself plus one peer.
    expect(leader.votesGranted).toHaveLength(2)
  })

  it('leaves the followers in the leader term with no election pending', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 1000, draws)

    for (const id of ['n2', 'n3']) {
      const follower = node(cluster, id)
      expect(follower.role).toBe('follower')
      expect(follower.currentTerm).toBe(1)
      expect(follower.votedFor).toBe('n1')
    }
  })

  // Heartbeats are the only reason the followers stay quiet. If they stopped,
  // the shortest follower timeout would fire and the term would advance.
  it('holds the term at 1 — heartbeats keep the followers from timing out', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 1000, draws)

    for (const n of cluster.nodes.values()) {
      expect(n.currentTerm).toBe(1)
    }
    expect(HEARTBEAT_INTERVAL).toBeLessThan(Math.min(...Object.values(timeouts)))
  })

  it('never lets the leader change identity once elected', () => {
    const cluster = makeCluster(timeouts)
    const seen = new Set<NodeId>()

    for (let i = 0; i < 1000; i++) {
      run(cluster, 1, draws)
      for (const leader of leaders(cluster)) seen.add(leader.id)
    }

    expect([...seen]).toEqual(['n1'])
  })
})

describe('split vote', () => {
  // Four nodes, identical timeouts: all four wake on the same tick, all four
  // vote for themselves, and a majority of four is three. Nobody can win.
  const timeouts = { n1: 150, n2: 150, n3: 150, n4: 150 }
  // The redraws are what break the tie — n1 wakes first next time round.
  const draws = { n1: 160, n2: 200, n3: 240, n4: 280 }

  it('produces four candidates and no leader in the contested term', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 150, draws)

    expect(leaders(cluster)).toHaveLength(0)
    for (const n of cluster.nodes.values()) {
      expect(n.role).toBe('candidate')
      expect(n.currentTerm).toBe(1)
      expect(n.votedFor).toBe(n.id)
      // Its own vote and nothing else: every peer had already voted for itself.
      expect(n.votesGranted).toEqual([n.id])
    }
  })

  it('resolves on the next election, at a higher term', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 1000, draws)

    const elected = leaders(cluster)
    expect(elected).toHaveLength(1)
    expect(elected[0].id).toBe('n1')
    expect(elected[0].currentTerm).toBe(2)
  })

  it('holds Election Safety across the whole contested run', () => {
    const cluster = makeCluster(timeouts)

    // run() asserts the safety properties after every tick.
    expect(() => run(cluster, 1000, draws)).not.toThrow()
  })

  it('brings the losing candidates back to followers of the winner', () => {
    const cluster = makeCluster(timeouts)

    run(cluster, 1000, draws)

    for (const id of ['n2', 'n3', 'n4']) {
      const follower = node(cluster, id)
      expect(follower.role).toBe('follower')
      expect(follower.currentTerm).toBe(2)
      expect(follower.votedFor).toBe('n1')
      expect(follower.votesGranted).toEqual([])
    }
  })
})
