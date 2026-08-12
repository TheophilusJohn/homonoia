import { describe, expect, it } from 'vitest'

import type { NodeId } from '../raft/types'
import { allNodes, createSim, leaders, submit } from '../sim/sim'
import type { Sim, SimOptions } from '../sim/sim'
import { runChecked } from './invariants'

const NODES: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

function options(overrides: Partial<SimOptions> = {}): SimOptions {
  return {
    seed: 909,
    nodes: NODES,
    latency: { min: 1, max: 4 },
    electionTimeout: { min: 150, max: 300 },
    ...overrides,
  }
}

/** A cluster with a settled leader. */
function elected(overrides: Partial<SimOptions> = {}): Sim {
  const sim = createSim(options(overrides))
  runChecked(sim, 600)
  expect(leaders(sim)).toHaveLength(1)
  return sim
}

describe('replication over the simulated network', () => {
  it('replicates a command to every node and applies it everywhere', () => {
    const sim = elected()

    submit(sim, { key: 'colour', value: 'blue' })
    runChecked(sim, 400)

    for (const node of allNodes(sim)) {
      expect(node.log).toHaveLength(1)
      expect(node.commitIndex).toBe(1)
      expect(node.kv).toEqual({ colour: 'blue' })
    }
  })

  it('keeps every log identical across a stream of commands', () => {
    const sim = elected()

    for (let i = 1; i <= 20; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 20)
    }
    runChecked(sim, 400)

    const [first, ...rest] = allNodes(sim)
    for (const node of rest) {
      expect(node.log).toEqual(first.log)
      expect(node.commitIndex).toBe(first.commitIndex)
      expect(node.kv).toEqual(first.kv)
    }
    expect(first.log).toHaveLength(20)
    expect(first.commitIndex).toBe(20)
  })

  it('applies overwrites in log order, so every node agrees on the last value', () => {
    const sim = elected()

    for (const value of ['one', 'two', 'three']) {
      submit(sim, { key: 'k', value })
      runChecked(sim, 20)
    }
    runChecked(sim, 400)

    for (const node of allNodes(sim)) {
      expect(node.kv).toEqual({ k: 'three' })
      expect(node.log).toHaveLength(3)
    }
  })

  it('leaves lastApplied tracking commitIndex on every node', () => {
    const sim = elected()

    for (let i = 1; i <= 5; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 60)
    }

    for (const node of allNodes(sim)) {
      expect(node.lastApplied).toBe(node.commitIndex)
      expect(Object.keys(node.kv)).toHaveLength(5)
    }
  })

  // Dropped AppendEntries are retried on the next heartbeat, so a lossy
  // network costs latency, not correctness.
  it('still converges when one message in five is dropped', () => {
    const sim = elected({ dropProbability: 0.2 })

    for (let i = 1; i <= 10; i++) {
      submit(sim, { key: `k${i}`, value: `v${i}` })
      runChecked(sim, 40)
    }
    runChecked(sim, 1500)

    const [first, ...rest] = allNodes(sim)
    expect(first.log).toHaveLength(10)
    for (const node of rest) {
      expect(node.log).toEqual(first.log)
      expect(node.kv).toEqual(first.kv)
    }
    expect(sim.bus.stats.dropped).toBeGreaterThan(0)
  })
})
