import type { NodeId, Rpc } from '../raft/types'
import {
  allNodes,
  createSim,
  healCluster,
  inFlight,
  kill,
  leaders,
  partitionCluster,
  revive,
  submit,
  submitTo,
  tick as advance,
} from '../sim/sim'
import type { Sim } from '../sim/sim'
import type { TraceEvent } from '../sim/trace'
import { EVENT_CAP, pruneEffects } from './viewModel'
import type {
  DropView,
  EventTone,
  EventView,
  Feed,
  LogCellView,
  MessageKind,
  MessageView,
  NodeView,
  PulseView,
  ViewState,
} from './viewModel'

/**
 * The real feed: a running Sim projected into ViewState.
 *
 * Transient effects are read out of the trace rather than inferred from state
 * diffs, so what the field draws is exactly what the harness recorded.
 *
 * Seeking backwards rebuilds the sim from its seed and replays — cheap, and
 * exact, because a seed reproduces a run down to the interleaving.
 */

export interface SimFeedOptions {
  readonly seed: number
  readonly nodes?: readonly NodeId[]
  readonly latency?: number
  readonly dropPercent?: number
  /**
   * Ticks between automatic client commands.
   *
   * Without a client the cluster elects a leader and then does nothing
   * observable but heartbeat — the log stays empty and the commit
   * crystallization, which is the whole point of the ledger, never fires. A
   * steady trickle is what an instrument pointed at a *running* system should
   * show. The Command button submits on top of it.
   */
  readonly commandEvery?: number
}

/** How long a truncated entry lingers in the view so the shatter can be seen. */
const GHOST_TICKS = 14

const DEFAULT_NODES: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

export interface SimFeed extends Feed {
  readonly sim: Sim
  /** Rebuild from scratch with new settings. */
  configure(options: Partial<SimFeedOptions>): void
  options(): SimFeedOptions
  toggleNode(id: NodeId): void
  submitCommand(): void
  /** Submit to a named node — a partitioned cluster can hold two leaders. */
  submitTo(id: NodeId, key: string, value: string): void
  partition(groups: readonly (readonly NodeId[])[]): void
  heal(): void
  currentPartition(): readonly (readonly NodeId[])[] | null
  leaderId(): NodeId | null
  /** Change background client traffic without restarting the run. */
  setLoad(commandEvery: number): void
}

interface Ghost {
  readonly nodeId: NodeId
  readonly index: number
  readonly term: number
  readonly at: number
}

function kindOf(rpc: Rpc): MessageKind {
  return rpc.type === 'request-vote-req' || rpc.type === 'request-vote-res' ? 'vote' : 'append'
}

function describe(event: TraceEvent): { text: string; tone: EventTone } | null {
  switch (event.kind) {
    case 'client-command':
      return { text: `client → ${event.to} · set ${event.command.key}=${event.command.value}`, tone: 'leader' }
    case 'kill':
      return { text: `${event.id} killed`, tone: 'warn' }
    case 'revive':
      return { text: `${event.id} revived · restarts as follower`, tone: 'good' }
    case 'partition':
      return event.groups === null
        ? { text: 'partition healed', tone: 'good' }
        : { text: `network partitioned · ${event.groups.map((g) => `{${g.join(',')}}`).join(' ⁄ ')}`, tone: 'warn' }
    case 'drop':
      return { text: `${event.message.from} → ${event.message.to} · dropped (${event.reason})`, tone: 'warn' }
    default:
      return null
  }
}

export function createSimFeed(initial: SimFeedOptions): SimFeed {
  let options: SimFeedOptions = {
    nodes: DEFAULT_NODES,
    latency: 4,
    dropPercent: 0,
    commandEvery: 22,
    ...initial,
  }
  let sim = build(options)

  let events: EventView[] = []
  let pulses: PulseView[] = []
  let drops: DropView[] = []
  let consumed = 0
  let lastCommit = 0
  let lastLeader: NodeId | null = null
  let counter = 0
  /** `${nodeId}:${index}` -> the tick that cell first became committed. */
  let committedAt = new Map<string, number>()
  /** Entries that have been truncated away, kept briefly so the removal is visible. */
  let ghosts: Ghost[] = []
  let previousLogs = new Map<NodeId, number>()
  let groups: readonly (readonly NodeId[])[] | null = null

  function build(o: SimFeedOptions): Sim {
    const latency = o.latency ?? 4
    return createSim({
      seed: o.seed,
      nodes: o.nodes ?? DEFAULT_NODES,
      // A one-tick floor keeps cause before effect; the slider sets the ceiling.
      latency: { min: 1, max: Math.max(1, latency) },
      electionTimeout: { min: 50, max: 100 },
      dropProbability: (o.dropPercent ?? 0) / 100,
    })
  }

  function reset(): void {
    sim = build(options)
    events = []
    pulses = []
    drops = []
    consumed = 0
    lastCommit = 0
    lastLeader = null
    counter = 0
    committedAt = new Map()
    ghosts = []
    previousLogs = new Map()
    if (groups) partitionCluster(sim, groups.map((g) => [...g]))
  }

  /** Drain trace events written since the last call into stream lines and effects. */
  function harvest(): void {
    const trace = sim.tracer.events

    for (; consumed < trace.length; consumed++) {
      const event = trace[consumed]

      if (event.kind === 'deliver') {
        pulses.push({
          key: `rc-${event.seq}`,
          node: event.message.to,
          kind: 'receive',
          at: event.tick,
        })
        continue
      }

      if (event.kind === 'drop') {
        // The cause travels with the drop; the renderer decides where on the
        // arc it comes apart, because only it knows where the rift is.
        drops.push({
          key: `dp-${counter++}`,
          from: event.message.from,
          to: event.message.to,
          at: event.tick,
          cause: event.reason,
        })
      }

      const line = describe(event)
      if (line) {
        events.push({ key: `ev-${counter++}`, tick: event.tick, text: line.text, tone: line.tone })
      }
    }
  }

  function observe(): void {
    const [leader] = leaders(sim)

    if (leader && leader.id !== lastLeader) {
      lastLeader = leader.id
      pulses.push({ key: `el-${leader.id}-${leader.currentTerm}`, node: leader.id, kind: 'elected', at: sim.now })
      events.push({
        key: `ev-${counter++}`,
        tick: sim.now,
        text: `${leader.id} elected leader · term ${leader.currentTerm}`,
        tone: 'leader',
      })
    }
    if (!leader) lastLeader = null

    const commit = Math.max(...allNodes(sim).map((node) => node.commitIndex))
    if (commit > lastCommit) {
      pulses.push({
        key: `cm-${commit}`,
        node: leader?.id ?? allNodes(sim)[0].id,
        kind: 'commit',
        at: sim.now,
      })
      events.push({
        key: `ev-${counter++}`,
        tick: sim.now,
        text: `commit index → ${commit} · majority replicated`,
        tone: 'good',
      })
      lastCommit = commit
    }

    // A shrinking log means entries were truncated. Hold on to them for a
    // moment so the ledger can show them being taken away rather than simply
    // blinking out.
    for (const node of allNodes(sim)) {
      const before = previousLogs.get(node.id)
      if (before !== undefined && node.log.length < before) {
        for (let index = node.log.length + 1; index <= before; index++) {
          ghosts.push({ nodeId: node.id, index, term: 0, at: sim.now })
        }
        events.push({
          key: `ev-${counter++}`,
          tick: sim.now,
          text: `${node.id} log conflict · truncating to index ${node.log.length}`,
          tone: 'warn',
        })
      }
      previousLogs.set(node.id, node.log.length)
    }

    for (const node of allNodes(sim)) {
      for (let index = 1; index <= node.commitIndex; index++) {
        const key = `${node.id}:${index}`
        if (!committedAt.has(key)) committedAt.set(key, sim.now)
      }
    }

    // A leader emits a ring on each heartbeat fan-out.
    if (leader && leader.heartbeatElapsed === 0) {
      pulses.push({ key: `hb-${leader.id}-${sim.now}`, node: leader.id, kind: 'heartbeat', at: sim.now })
    }
  }

  function snapshot(time: number): ViewState {
    const [leader] = leaders(sim)
    const states = allNodes(sim)
    const maxCommit = Math.max(...states.map((node) => node.commitIndex))
    // The leader's log is the yardstick for divergence. This is an observer's
    // comparison, not something any node computes.
    const reference = leader?.log ?? []

    const nodes: NodeView[] = states.map((node) => {
      const alive = sim.alive.has(node.id)
      const log: LogCellView[] = node.log.map((entry, i) => {
        const committed = i + 1 <= node.commitIndex
        const mismatch =
          !committed && reference[i] !== undefined && reference[i].term !== entry.term
        return {
          index: i + 1,
          term: entry.term,
          state: committed ? 'committed' : mismatch ? 'divergent' : 'uncommitted',
          label: String(entry.term),
          committedAt: committedAt.get(`${node.id}:${i + 1}`),
        }
      })

      for (const ghost of ghosts) {
        if (ghost.nodeId !== node.id) continue
        log.push({
          index: ghost.index,
          term: ghost.term,
          state: 'truncated',
          label: '',
          truncatedAt: ghost.at,
        })
      }
      return {
        id: node.id,
        role: alive ? node.role : 'follower',
        term: node.currentTerm,
        alive,
        commitIndex: node.commitIndex,
        log,
      }
    })

    const messages: MessageView[] = inFlight(sim).map((flight) => ({
      key: flight.seq,
      from: flight.message.from,
      to: flight.message.to,
      kind: kindOf(flight.message.rpc),
      sentAt: flight.sentAt,
      deliverAt: flight.deliverAt,
    }))

    const phase = leader
      ? states.some((node) => node.role === 'candidate')
        ? 'contested'
        : 'steady'
      : 'leaderless'

    return {
      time,
      tick: sim.now,
      term: Math.max(...states.map((node) => node.currentTerm)),
      commitIndex: maxCommit,
      phase,
      nodes,
      partition: groups,
      messages,
      pulses: pruneEffects(pulses, sim.now),
      drops: pruneEffects(drops, sim.now),
      events: events.slice(-EVENT_CAP),
    }
  }

  return {
    kind: 'sim',
    get sim() {
      return sim
    },

    seek(time: number): ViewState {
      const target = Math.floor(time)
      if (target < sim.now) reset()

      while (sim.now < target) {
        ghosts = ghosts.filter((ghost) => sim.now - ghost.at <= GHOST_TICKS)
        const every = options.commandEvery ?? 0
        if (every > 0 && sim.now > 0 && sim.now % every === 0) {
          counter += 1
          submit(sim, { key: `k${counter % 6}`, value: `v${counter}` })
          harvest()
        }

        advance(sim)
        harvest()
        observe()
        pulses = pruneEffects(pulses, sim.now)
        drops = pruneEffects(drops, sim.now)
        if (events.length > EVENT_CAP * 3) events = events.slice(-EVENT_CAP)
      }

      return snapshot(time)
    },

    configure(next: Partial<SimFeedOptions>): void {
      options = { ...options, ...next }
      reset()
    },

    options: () => options,

    toggleNode(id: NodeId): void {
      if (sim.alive.has(id)) kill(sim, id)
      else revive(sim, id)
      harvest()
    },

    submitCommand(): void {
      counter += 1
      submit(sim, { key: `k${counter % 8}`, value: `v${counter}` })
      harvest()
    },

    submitTo(id: NodeId, key: string, value: string): void {
      submitTo(sim, id, { key, value })
      harvest()
    },

    partition(next: readonly (readonly NodeId[])[]): void {
      groups = next.map((group) => [...group])
      partitionCluster(
        sim,
        groups.map((group) => [...group]),
      )
      harvest()
    },

    heal(): void {
      groups = null
      healCluster(sim)
      harvest()
    },

    currentPartition: () => groups,
    leaderId: () => leaders(sim)[0]?.id ?? null,

    setLoad(commandEvery: number): void {
      options = { ...options, commandEvery }
    },
  }
}
