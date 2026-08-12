import { step } from '../raft/step'
import type { Command, Event, Message, NodeId, NodeState } from '../raft/types'
import { collectDue, createBus, heal, partition, send } from './bus'
import type { Bus, Latency } from './bus'
import { makePrng } from './prng'
import type { Prng } from './prng'

/**
 * The driver: a virtual clock, a set of nodes, and the simulated network
 * between them.
 *
 * Everything non-deterministic in a run — latency, drops, duplicates, election
 * timeouts — is drawn from one seeded PRNG in a fixed order, so a seed
 * reproduces a run exactly, down to the interleaving. That is the property the
 * fuzz harness in milestone 5 depends on.
 *
 * The core never learns any of this exists. It sees ticks and deliveries.
 */

export interface SimOptions {
  readonly seed: number
  readonly nodes: readonly NodeId[]
  readonly latency: Latency
  /** Election timeout range in ticks, sampled per election. */
  readonly electionTimeout: Latency
  readonly dropProbability?: number
  readonly duplicateProbability?: number
}

export interface Sim {
  now: number
  readonly nodes: Map<NodeId, NodeState>
  /** Nodes that are running. A killed node is absent. */
  readonly alive: Set<NodeId>
  readonly bus: Bus
  readonly prng: Prng
  readonly electionTimeout: Latency
  readonly seed: number
}

export function createSim(options: SimOptions): Sim {
  const prng = makePrng(options.seed)
  const bus = createBus({
    latency: options.latency,
    dropProbability: options.dropProbability ?? 0,
    duplicateProbability: options.duplicateProbability ?? 0,
  })

  const ids = [...options.nodes]
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
      electionTimeout: drawElectionTimeout(prng, options.electionTimeout),
      heartbeatElapsed: 0,
      votesGranted: [],
      nextIndex: {},
      matchIndex: {},
    })
  }

  return {
    now: 0,
    nodes,
    alive: new Set(ids),
    bus,
    prng,
    electionTimeout: options.electionTimeout,
    seed: options.seed,
  }
}

function drawElectionTimeout(prng: Prng, range: Latency): number {
  return prng.nextInt(range.min, range.max + 1)
}

/**
 * Advance the virtual clock.
 *
 * Each tick delivers everything the network has due, then ticks every live
 * node. Deliveries land before timers advance, so a heartbeat that arrives on
 * the same tick a follower would have timed out is seen first — which is the
 * generous reading, and the one that does not manufacture spurious elections.
 */
export function tick(sim: Sim, count = 1): void {
  for (let i = 0; i < count; i++) {
    sim.now += 1

    for (const message of collectDue(sim.bus, sim.now)) {
      // A killed node receives nothing. The message is simply gone.
      if (!sim.alive.has(message.to)) continue
      apply(sim, message.to, { type: 'deliver', message })
    }

    for (const id of sim.nodes.keys()) {
      // A killed node produces no output and its timers do not advance.
      if (!sim.alive.has(id)) continue
      apply(sim, id, {
        type: 'tick',
        now: sim.now,
        randomElectionTimeout: drawElectionTimeout(sim.prng, sim.electionTimeout),
      })
    }
  }
}

function apply(sim: Sim, id: NodeId, event: Event): void {
  const { state, outbox } = step(nodeState(sim, id), event)
  sim.nodes.set(id, state)
  send(sim.bus, sim.prng, sim.now, outbox)
}

// --- Node lifecycle ---

/**
 * Stop a node. It receives no events and produces no output until revived.
 *
 * Messages it already put on the wire still arrive — they are out of its hands.
 */
export function kill(sim: Sim, id: NodeId): void {
  nodeState(sim, id)
  sim.alive.delete(id)
}

/**
 * Restart a node.
 *
 * Persistent state survives a crash: currentTerm, votedFor and the log are
 * exactly what Figure 2 requires to be on stable storage before an RPC is
 * answered. Everything volatile is rebuilt from nothing — commitIndex and
 * lastApplied return to 0 and the state machine empties, so the node reapplies
 * its log as a leader tells it what is committed. Leader and candidate state is
 * meaningless after a restart and goes too; the node comes back a follower.
 */
export function revive(sim: Sim, id: NodeId): void {
  const state = nodeState(sim, id)

  sim.nodes.set(id, {
    ...state,

    // Persistent, untouched: currentTerm, votedFor, log.

    role: 'follower',
    commitIndex: 0,
    lastApplied: 0,
    kv: {},
    votesGranted: [],
    nextIndex: {},
    matchIndex: {},
    electionElapsed: 0,
    electionTimeout: drawElectionTimeout(sim.prng, sim.electionTimeout),
    heartbeatElapsed: 0,
  })

  sim.alive.add(id)
}

export function isAlive(sim: Sim, id: NodeId): boolean {
  return sim.alive.has(id)
}

// --- Network control ---

export function partitionCluster(sim: Sim, groups: NodeId[][]): void {
  partition(sim.bus, groups)
}

export function healCluster(sim: Sim): void {
  heal(sim.bus)
}

// --- Inspection ---

export function nodeState(sim: Sim, id: NodeId): NodeState {
  const state = sim.nodes.get(id)
  if (!state) throw new Error(`no such node: ${id}`)
  return state
}

export function allNodes(sim: Sim): NodeState[] {
  return [...sim.nodes.values()]
}

export function liveNodes(sim: Sim): NodeState[] {
  return allNodes(sim).filter((node) => sim.alive.has(node.id))
}

/**
 * Leaders among the *live* nodes.
 *
 * A killed node's state is frozen at the moment it died, so a dead leader still
 * says `role: 'leader'`. It is not one — it is not running. Counting it would
 * report a false Election Safety violation the instant a successor is elected.
 */
export function leaders(sim: Sim): NodeState[] {
  return liveNodes(sim).filter((node) => node.role === 'leader')
}

/** Submit a command to the current leader. Returns its id, or null if there is none. */
export function submit(sim: Sim, command: Command): NodeId | null {
  const [leader] = leaders(sim)
  if (!leader) return null

  apply(sim, leader.id, { type: 'client-command', command })
  return leader.id
}

/** Messages currently on the wire. For assertions and, later, the visualization. */
export function inFlight(sim: Sim): Message[] {
  return sim.bus.inFlight.map((flight) => flight.message)
}
