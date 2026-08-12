import type { Message, NodeId } from '../raft/types'
import type { Prng } from './prng'

/**
 * The simulated network.
 *
 * Every message is held in flight until its delivery tick. Latency is sampled
 * per message, independently, which is where reordering comes from: two
 * messages sent on the same tick with different latency draws arrive in the
 * opposite order. There is no separate shuffle step, because that would be a
 * lie about how a network misbehaves.
 *
 * Drops, duplicates and latency all draw from the driver's seeded PRNG, so a
 * whole run — including every reordering — is reproducible from its seed.
 */

export interface Latency {
  /** Inclusive. Must be at least 1: a message cannot arrive on the tick it was sent. */
  readonly min: number
  /** Inclusive. */
  readonly max: number
}

export interface BusConfig {
  readonly latency: Latency
  /** Probability in [0, 1] that a message is discarded at send time. */
  readonly dropProbability: number
  /**
   * Probability in [0, 1] that a message is sent twice. The copy draws its own
   * latency, so it can land before or after the original.
   */
  readonly duplicateProbability: number
}

interface InFlight {
  readonly message: Message
  readonly deliverAt: number
  /** Send order, used only to break ties between messages due on the same tick. */
  readonly seq: number
}

export interface BusStats {
  sent: number
  dropped: number
  duplicated: number
  partitioned: number
  delivered: number
}

export interface Bus {
  readonly config: BusConfig
  inFlight: InFlight[]
  /**
   * Groups of node IDs that can reach each other. Null means no partition —
   * everyone can reach everyone. A node in no group is fully isolated.
   */
  partitions: NodeId[][] | null
  seq: number
  stats: BusStats
}

export function createBus(config: BusConfig): Bus {
  if (config.latency.min < 1) {
    // A zero-tick latency would let a message be sent and delivered within one
    // tick, which collapses cause and effect and makes tick ordering
    // meaningless.
    throw new Error(`latency.min must be at least 1, got ${config.latency.min}`)
  }
  if (config.latency.max < config.latency.min) {
    throw new Error(`latency.max (${config.latency.max}) is below latency.min (${config.latency.min})`)
  }
  for (const [name, p] of [
    ['dropProbability', config.dropProbability],
    ['duplicateProbability', config.duplicateProbability],
  ] as const) {
    if (p < 0 || p > 1) throw new Error(`${name} must be in [0, 1], got ${p}`)
  }

  return {
    config,
    inFlight: [],
    partitions: null,
    seq: 0,
    stats: { sent: 0, dropped: 0, duplicated: 0, partitioned: 0, delivered: 0 },
  }
}

/** Hand messages to the network. They are not delivered here. */
export function send(bus: Bus, prng: Prng, now: number, messages: readonly Message[]): void {
  for (const message of messages) {
    bus.stats.sent += 1

    if (prng.nextFloat() < bus.config.dropProbability) {
      bus.stats.dropped += 1
      continue
    }

    enqueue(bus, prng, now, message)

    if (prng.nextFloat() < bus.config.duplicateProbability) {
      bus.stats.duplicated += 1
      enqueue(bus, prng, now, message)
    }
  }
}

function enqueue(bus: Bus, prng: Prng, now: number, message: Message): void {
  const { min, max } = bus.config.latency
  bus.inFlight.push({
    message,
    deliverAt: now + prng.nextInt(min, max + 1),
    seq: bus.seq++,
  })
}

/**
 * Remove and return everything due at or before `now`, in delivery order.
 *
 * The partition check happens here rather than at send time, so a message
 * already on the wire when a partition forms is discarded, and one that is
 * still in flight when the partition heals gets through.
 */
export function collectDue(bus: Bus, now: number): Message[] {
  const due: InFlight[] = []
  const waiting: InFlight[] = []

  for (const flight of bus.inFlight) {
    if (flight.deliverAt <= now) due.push(flight)
    else waiting.push(flight)
  }
  bus.inFlight = waiting

  due.sort((a, b) => a.deliverAt - b.deliverAt || a.seq - b.seq)

  const delivered: Message[] = []
  for (const flight of due) {
    if (!canReach(bus, flight.message.from, flight.message.to)) {
      bus.stats.partitioned += 1
      continue
    }
    bus.stats.delivered += 1
    delivered.push(flight.message)
  }

  return delivered
}

/** Can `from` reach `to` under the current partition? */
export function canReach(bus: Bus, from: NodeId, to: NodeId): boolean {
  if (bus.partitions === null) return true

  const group = bus.partitions.find((members) => members.includes(from))
  return group !== undefined && group.includes(to)
}

/**
 * Split the cluster. Messages crossing a group boundary are discarded at
 * delivery. Nodes left out of every group are isolated from everyone.
 */
export function partition(bus: Bus, groups: NodeId[][]): void {
  bus.partitions = groups.map((group) => [...group])
}

export function heal(bus: Bus): void {
  bus.partitions = null
}
