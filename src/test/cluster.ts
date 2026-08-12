import { expect } from 'vitest'

import { step } from '../raft/step'
import type { Command, Message, NodeId, NodeState } from '../raft/types'

/**
 * Minimal in-test driver: instant delivery, no drops, no reordering, no
 * partitions, no crashes. Enough to watch an election settle and a log
 * replicate. The real message bus is milestone 4, and the fuzz harness that
 * drives it is milestone 5.
 */
export interface Cluster {
  nodes: Map<NodeId, NodeState>
  now: number
}

export function makeCluster(timeouts: Record<NodeId, number>): Cluster {
  const ids = Object.keys(timeouts)
  const nodes = new Map<NodeId, NodeState>()

  for (const id of ids) {
    nodes.set(id, {
      id,
      peers: ids.filter((other) => other !== id),
      role: 'follower',
      currentTerm: 0,
      votedFor: null,
      log: [],
      commitIndex: 0,
      lastApplied: 0,
      kv: {},
      electionElapsed: 0,
      electionTimeout: timeouts[id],
      heartbeatElapsed: 0,
      votesGranted: [],
      nextIndex: {},
      matchIndex: {},
    })
  }

  return { nodes, now: 0 }
}

/** Advance every node one tick, returning whatever they emitted. */
export function tickAll(cluster: Cluster, draws: Record<NodeId, number>): Message[] {
  cluster.now += 1
  const emitted: Message[] = []

  for (const id of [...cluster.nodes.keys()]) {
    const { state, outbox } = step(cluster.nodes.get(id)!, {
      type: 'tick',
      now: cluster.now,
      randomElectionTimeout: draws[id],
    })
    cluster.nodes.set(id, state)
    emitted.push(...outbox)
  }

  return emitted
}

/** Deliver messages FIFO, including everything they provoke, until quiescent. */
export function deliverAll(cluster: Cluster, messages: Message[]): void {
  const queue = [...messages]

  for (let guard = 0; queue.length > 0; guard++) {
    if (guard > 10_000) throw new Error('message storm: cluster never went quiet')

    const message = queue.shift()!
    const { state, outbox } = step(cluster.nodes.get(message.to)!, { type: 'deliver', message })
    cluster.nodes.set(message.to, state)
    queue.push(...outbox)
  }
}

export function leaders(cluster: Cluster): NodeState[] {
  return [...cluster.nodes.values()].filter((node) => node.role === 'leader')
}

export function node(cluster: Cluster, id: NodeId): NodeState {
  const found = cluster.nodes.get(id)
  if (!found) throw new Error(`no such node: ${id}`)
  return found
}

/** Submit a command to the current leader. Throws if there is no leader. */
export function submit(cluster: Cluster, command: Command): void {
  const [leader] = leaders(cluster)
  if (!leader) throw new Error('no leader to accept the command')

  const { state, outbox } = step(leader, { type: 'client-command', command })
  cluster.nodes.set(leader.id, state)
  deliverAll(cluster, outbox)
}

// --- Safety properties ---
//
// Predicates over the whole cluster, asserted after every tick. Milestone 5
// completes the set and checks them across thousands of seeded runs; these
// three are the ones replication can break.

/** Property 1, Election Safety: at most one leader per term. */
function electionSafety(cluster: Cluster): void {
  const byTerm = new Map<number, NodeId[]>()

  for (const leader of leaders(cluster)) {
    byTerm.set(leader.currentTerm, [...(byTerm.get(leader.currentTerm) ?? []), leader.id])
  }

  for (const [term, ids] of byTerm) {
    expect(ids, `two leaders in term ${term}`).toHaveLength(1)
  }
}

/**
 * Property 3, Log Matching: if two logs hold an entry with the same index and
 * term, the logs are identical in every preceding entry.
 */
function logMatching(cluster: Cluster): void {
  const all = [...cluster.nodes.values()]

  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const shared = Math.min(all[a].log.length, all[b].log.length)

      for (let i = shared - 1; i >= 0; i--) {
        if (all[a].log[i].term !== all[b].log[i].term) continue

        expect(
          all[a].log.slice(0, i + 1),
          `log mismatch below index ${i + 1} between ${all[a].id} and ${all[b].id}`,
        ).toEqual(all[b].log.slice(0, i + 1))
        break
      }
    }
  }
}

/**
 * Property 5, State Machine Safety, in its within-run form: no two nodes hold
 * different entries at the same committed index.
 */
function committedPrefixAgreement(cluster: Cluster): void {
  const all = [...cluster.nodes.values()]

  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const upTo = Math.min(all[a].commitIndex, all[b].commitIndex)

      expect(
        all[a].log.slice(0, upTo),
        `committed prefix diverged between ${all[a].id} and ${all[b].id}`,
      ).toEqual(all[b].log.slice(0, upTo))
    }
  }
}

export function checkInvariants(cluster: Cluster): void {
  electionSafety(cluster)
  logMatching(cluster)
  committedPrefixAgreement(cluster)
}

/** Run `ticks` ticks, checking the safety properties after each one. */
export function run(cluster: Cluster, ticks: number, draws: Record<NodeId, number>): void {
  for (let i = 0; i < ticks; i++) {
    deliverAll(cluster, tickAll(cluster, draws))
    checkInvariants(cluster)
  }
}
