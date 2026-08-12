import { describe, expect, it } from 'vitest'

import type { Message, NodeId } from '../raft/types'
import { canReach, collectDue, createBus, heal, partition, send } from './bus'
import { makePrng } from './prng'
import {
  allNodes,
  createSim,
  healCluster,
  isAlive,
  kill,
  leaders,
  nodeState,
  partitionCluster,
  revive,
  submit,
  tick,
} from './sim'
import type { SimOptions } from './sim'

const NODES: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

function options(overrides: Partial<SimOptions> = {}): SimOptions {
  return {
    seed: 1,
    nodes: NODES,
    latency: { min: 1, max: 4 },
    electionTimeout: { min: 150, max: 300 },
    ...overrides,
  }
}

function ping(from: NodeId, to: NodeId): Message {
  return {
    from,
    to,
    rpc: { type: 'append-entries-res', term: 1, success: true, matchIndex: 0 },
  }
}

describe('bus', () => {
  it('rejects a latency floor below one tick', () => {
    // A message delivered on the tick it was sent collapses cause and effect.
    expect(() =>
      createBus({ latency: { min: 0, max: 3 }, dropProbability: 0, duplicateProbability: 0 }),
    ).toThrow(/at least 1/)
  })

  it('rejects an inverted latency range and out-of-range probabilities', () => {
    expect(() =>
      createBus({ latency: { min: 5, max: 2 }, dropProbability: 0, duplicateProbability: 0 }),
    ).toThrow(/below latency.min/)
    expect(() =>
      createBus({ latency: { min: 1, max: 2 }, dropProbability: 1.5, duplicateProbability: 0 }),
    ).toThrow(/dropProbability/)
  })

  it('holds a message until its delivery tick', () => {
    const bus = createBus({
      latency: { min: 3, max: 3 },
      dropProbability: 0,
      duplicateProbability: 0,
    })
    send(bus, makePrng(1), 10, [ping('n1', 'n2')])

    expect(collectDue(bus, 11)).toHaveLength(0)
    expect(collectDue(bus, 12)).toHaveLength(0)
    expect(collectDue(bus, 13)).toHaveLength(1)
  })

  // Reordering is not a separate shuffle — it falls out of sampling latency per
  // message. Two messages sent on the same tick arrive in whatever order their
  // draws dictate.
  it('reorders messages sent on the same tick', () => {
    const bus = createBus({
      latency: { min: 1, max: 30 },
      dropProbability: 0,
      duplicateProbability: 0,
    })
    const prng = makePrng(7)

    const sent = NODES.map((to) => ping('n1', to))
    send(bus, prng, 0, sent)

    const arrived: Message[] = []
    for (let now = 1; now <= 30; now++) arrived.push(...collectDue(bus, now))

    expect(arrived).toHaveLength(sent.length)
    // Same set, different order.
    expect(arrived.map((m) => m.to).sort()).toEqual(sent.map((m) => m.to).sort())
    expect(arrived.map((m) => m.to)).not.toEqual(sent.map((m) => m.to))
  })

  it('drops messages at the configured rate', () => {
    const bus = createBus({
      latency: { min: 1, max: 2 },
      dropProbability: 1,
      duplicateProbability: 0,
    })
    send(bus, makePrng(3), 0, [ping('n1', 'n2'), ping('n1', 'n3')])

    expect(bus.stats.dropped).toBe(2)
    expect(collectDue(bus, 99)).toHaveLength(0)
  })

  it('duplicates messages, each copy with its own latency', () => {
    const bus = createBus({
      latency: { min: 1, max: 20 },
      dropProbability: 0,
      duplicateProbability: 1,
    })
    send(bus, makePrng(11), 0, [ping('n1', 'n2')])

    expect(bus.stats.duplicated).toBe(1)
    expect(bus.inFlight).toHaveLength(2)
    // Independent draws, so the copies are not glued together.
    expect(bus.inFlight[0].deliverAt).not.toBe(bus.inFlight[1].deliverAt)
  })

  it('discards messages that cross a partition boundary', () => {
    const bus = createBus({
      latency: { min: 1, max: 1 },
      dropProbability: 0,
      duplicateProbability: 0,
    })
    partition(bus, [
      ['n1', 'n2', 'n3'],
      ['n4', 'n5'],
    ])

    expect(canReach(bus, 'n1', 'n2')).toBe(true)
    expect(canReach(bus, 'n4', 'n5')).toBe(true)
    expect(canReach(bus, 'n1', 'n4')).toBe(false)

    send(bus, makePrng(1), 0, [ping('n1', 'n2'), ping('n1', 'n4')])
    const arrived = collectDue(bus, 1)

    expect(arrived).toHaveLength(1)
    expect(arrived[0].to).toBe('n2')
    expect(bus.stats.partitioned).toBe(1)
  })

  it('isolates a node left out of every group', () => {
    const bus = createBus({
      latency: { min: 1, max: 1 },
      dropProbability: 0,
      duplicateProbability: 0,
    })
    partition(bus, [['n1', 'n2']])

    expect(canReach(bus, 'n3', 'n1')).toBe(false)
    expect(canReach(bus, 'n1', 'n3')).toBe(false)
  })

  // The boundary is checked on delivery, so a message still in flight when the
  // partition heals gets through.
  it('delivers an in-flight message once the partition heals', () => {
    const bus = createBus({
      latency: { min: 5, max: 5 },
      dropProbability: 0,
      duplicateProbability: 0,
    })
    partition(bus, [['n1'], ['n2']])
    send(bus, makePrng(1), 0, [ping('n1', 'n2')])

    heal(bus)

    expect(collectDue(bus, 5)).toHaveLength(1)
  })
})

describe('determinism', () => {
  function fingerprint(seed: number): string {
    const sim = createSim(options({ seed }))
    for (let i = 0; i < 400; i++) {
      tick(sim)
      if (i === 200) submit(sim, { key: 'k', value: 'v' })
    }
    return JSON.stringify(allNodes(sim).map((n) => [n.id, n.role, n.currentTerm, n.log, n.kv]))
  }

  it('reproduces a run exactly from its seed', () => {
    expect(fingerprint(12345)).toBe(fingerprint(12345))
  })

  it('produces different runs from different seeds', () => {
    // Not a correctness property, but if this failed the fuzz sweep in
    // milestone 5 would be running the same run a thousand times.
    const runs = new Set([1, 2, 3, 4, 5].map(fingerprint))
    expect(runs.size).toBeGreaterThan(1)
  })
})

describe('node lifecycle', () => {
  it('gives a killed node no events and no output', () => {
    const sim = createSim(options())
    tick(sim, 400)
    const leader = leaders(sim)[0]
    expect(leader).toBeDefined()

    kill(sim, leader.id)
    const frozen = nodeState(sim, leader.id)
    tick(sim, 300)

    expect(isAlive(sim, leader.id)).toBe(false)
    // Byte for byte the state it died with.
    expect(nodeState(sim, leader.id)).toEqual(frozen)
  })

  it('keeps persistent state and clears volatile state on revive', () => {
    const sim = createSim(options())
    tick(sim, 400)
    submit(sim, { key: 'a', value: '1' })
    tick(sim, 100)

    const victim = leaders(sim)[0]
    expect(victim.commitIndex).toBeGreaterThan(0)
    const before = nodeState(sim, victim.id)

    kill(sim, victim.id)
    revive(sim, victim.id)
    const after = nodeState(sim, victim.id)

    // Persistent — what Figure 2 requires on stable storage.
    expect(after.currentTerm).toBe(before.currentTerm)
    expect(after.votedFor).toBe(before.votedFor)
    expect(after.log).toEqual(before.log)

    // Volatile — rebuilt from nothing.
    expect(after.role).toBe('follower')
    expect(after.commitIndex).toBe(0)
    expect(after.lastApplied).toBe(0)
    expect(after.kv).toEqual({})
    expect(after.votesGranted).toEqual([])
    expect(after.nextIndex).toEqual({})
    expect(after.matchIndex).toEqual({})
  })

  it('reapplies the log after a revived node learns what is committed', () => {
    const sim = createSim(options())
    tick(sim, 400)
    submit(sim, { key: 'a', value: '1' })
    tick(sim, 100)

    const follower = allNodes(sim).find((n) => n.role === 'follower')!
    kill(sim, follower.id)
    revive(sim, follower.id)
    expect(nodeState(sim, follower.id).kv).toEqual({})

    tick(sim, 200)

    // The leader's heartbeat carries leaderCommit, and the node applies again.
    expect(nodeState(sim, follower.id).kv).toEqual({ a: '1' })
  })

  it('does not count a dead leader as a leader', () => {
    const sim = createSim(options())
    tick(sim, 400)
    const leader = leaders(sim)[0]

    kill(sim, leader.id)

    // Its frozen state still says leader; it is not running.
    expect(nodeState(sim, leader.id).role).toBe('leader')
    expect(leaders(sim).map((n) => n.id)).not.toContain(leader.id)
  })

  it('refuses to submit when every node is down', () => {
    const sim = createSim(options())
    tick(sim, 400)
    for (const id of NODES) kill(sim, id)

    expect(submit(sim, { key: 'k', value: 'v' })).toBeNull()
  })
})

describe('partition control', () => {
  it('stops a minority from electing anyone while the majority carries on', () => {
    const sim = createSim(options())
    tick(sim, 400)
    const leader = leaders(sim)[0]
    const minority = NODES.filter((id) => id !== leader.id).slice(0, 2)
    const majority = NODES.filter((id) => !minority.includes(id))

    partitionCluster(sim, [majority, minority])
    tick(sim, 600)

    // The majority side keeps a leader; the minority cannot reach a quorum.
    const stillLeading = leaders(sim).filter((n) => majority.includes(n.id))
    expect(stillLeading).toHaveLength(1)
    expect(leaders(sim).filter((n) => minority.includes(n.id))).toHaveLength(0)
  })

  it('lets the isolated nodes rejoin once healed', () => {
    const sim = createSim(options())
    tick(sim, 400)
    const leader = leaders(sim)[0]
    const minority = NODES.filter((id) => id !== leader.id).slice(0, 2)
    const majority = NODES.filter((id) => !minority.includes(id))

    partitionCluster(sim, [majority, minority])
    tick(sim, 600)
    healCluster(sim)
    tick(sim, 600)

    expect(leaders(sim)).toHaveLength(1)
    const terms = new Set(allNodes(sim).map((n) => n.currentTerm))
    expect(terms.size).toBe(1)
  })
})
