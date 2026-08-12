import type { NodeId, Role } from '../raft/types'
import { EVENT_CAP, pruneEffects } from './viewModel'
import type {
  DropView,
  EventView,
  Feed,
  LogCellView,
  MessageView,
  NodeView,
  PulseView,
  ViewState,
} from './viewModel'

/**
 * A scripted feed for building the render layer against.
 *
 * `seek(t)` is a pure function of t — no accumulated state, no simulation
 * running — so the field can be scrubbed to any moment and iterated on
 * frame by frame. It is not Raft and does not pretend to be: it exists to
 * exercise every visual state (election, replication, commit wave, drops,
 * a node down) on demand.
 *
 * The real feed is simFeed.ts. Anything that looks right here and wrong there
 * is a bug in the adapter, not in the renderer.
 */

const IDS: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']
const CYCLE = 340

interface Beat {
  readonly at: number
  readonly leader: number
  readonly term: number
  readonly logLength: number
  readonly committed: number
  readonly down?: number
  readonly phase: string
  readonly note?: { text: string; tone: EventView['tone'] }
}

/**
 * One loop of the script. Times are in ticks; the whole thing repeats, so a
 * scrub anywhere lands somewhere meaningful.
 */
const SCRIPT: Beat[] = [
  { at: 0, leader: 2, term: 4, logLength: 2, committed: 2, phase: 'steady', note: { text: 'n3 elected leader · term 4', tone: 'leader' } },
  { at: 30, leader: 2, term: 4, logLength: 3, committed: 2, phase: 'replicating', note: { text: 'client → n3 · set x=1', tone: 'leader' } },
  { at: 60, leader: 2, term: 4, logLength: 3, committed: 3, phase: 'steady', note: { text: 'commit index → 3 · majority replicated', tone: 'good' } },
  { at: 95, leader: 2, term: 4, logLength: 4, committed: 3, phase: 'replicating', note: { text: 'client → n3 · set y=7', tone: 'leader' } },
  { at: 125, leader: 2, term: 4, logLength: 4, committed: 4, phase: 'steady', note: { text: 'commit index → 4 · majority replicated', tone: 'good' } },
  { at: 160, leader: 2, term: 4, logLength: 4, committed: 4, down: 2, phase: 'leaderless', note: { text: 'n3 down · cluster without a leader', tone: 'warn' } },
  { at: 205, leader: 4, term: 5, logLength: 4, committed: 4, down: 2, phase: 'election', note: { text: 'n5 elected leader · term 5', tone: 'leader' } },
  { at: 240, leader: 4, term: 5, logLength: 5, committed: 4, down: 2, phase: 'replicating', note: { text: 'client → n5 · set z=9', tone: 'leader' } },
  { at: 270, leader: 4, term: 5, logLength: 5, committed: 5, down: 2, phase: 'steady', note: { text: 'commit index → 5 · majority replicated', tone: 'good' } },
  { at: 300, leader: 4, term: 5, logLength: 5, committed: 5, phase: 'steady', note: { text: 'n3 revived · restarts as follower', tone: 'good' } },
]

function beatAt(t: number): Beat {
  let current = SCRIPT[0]
  for (const beat of SCRIPT) {
    if (beat.at <= t) current = beat
    else break
  }
  return current
}

/** Deterministic pseudo-random in [0,1) from an integer — no PRNG state to desync. */
function hashed(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

const HEARTBEAT = 15

function roleOf(index: number, beat: Beat, t: number): Role {
  if (beat.down === index) return 'follower'
  if (beat.leader === index) return 'leader'
  // A brief candidate flicker just before an election resolves, so the
  // candidate colour is reachable while scrubbing.
  const next = SCRIPT.find((b) => b.at > t)
  if (next && next.leader === index && next.term > beat.term && next.at - t < 18) return 'candidate'
  return 'follower'
}

/** The tick at which an entry index first counts as committed in the script. */
function committedAtFor(entryIndex: number): number | undefined {
  const beat = SCRIPT.find((b) => b.committed >= entryIndex)
  return beat?.at
}

function logFor(index: number, beat: Beat): LogCellView[] {
  // Followers trail the leader by one entry while replication is in flight.
  const lag = beat.down === index ? 2 : index === beat.leader ? 0 : 0
  const length = Math.max(0, beat.logLength - lag)

  return Array.from({ length }, (_, i) => {
    const entryIndex = i + 1
    const committed = entryIndex <= beat.committed
    return {
      index: entryIndex,
      term: entryIndex <= 2 ? 3 : beat.term,
      state: committed ? ('committed' as const) : ('uncommitted' as const),
      label: String(entryIndex <= 2 ? 3 : beat.term),
      committedAt: committed ? committedAtFor(entryIndex) : undefined,
    }
  })
}

function messagesAt(t: number, beat: Beat): MessageView[] {
  if (beat.down === beat.leader) return []

  const out: MessageView[] = []
  const leader = IDS[beat.leader]

  // Heartbeat fan-out on every HEARTBEAT tick, still in flight for its latency.
  for (let origin = Math.floor(t / HEARTBEAT) * HEARTBEAT - HEARTBEAT; origin <= t; origin += HEARTBEAT) {
    IDS.forEach((id, i) => {
      if (i === beat.leader || beat.down === i) return
      const latency = 4 + Math.floor(hashed(origin * 7 + i) * 5)
      if (t < origin || t > origin + latency) return
      out.push({
        key: origin * 10 + i,
        from: leader,
        to: id,
        kind: 'append',
        sentAt: origin,
        deliverAt: origin + latency,
      })

      // Responses, offset so traffic reads as two-way.
      const replyAt = origin + latency
      const replyLatency = 3 + Math.floor(hashed(origin * 13 + i) * 5)
      if (t >= replyAt && t <= replyAt + replyLatency) {
        out.push({
          key: origin * 10 + i + 5,
          from: id,
          to: leader,
          kind: 'append',
          sentAt: replyAt,
          deliverAt: replyAt + replyLatency,
        })
      }
    })
  }

  // Election traffic reads violet.
  if (beat.phase === 'election' || beat.phase === 'leaderless') {
    const origin = Math.floor(t / 9) * 9
    IDS.forEach((id, i) => {
      if (i === beat.leader || beat.down === i) return
      const latency = 5
      if (t < origin || t > origin + latency) return
      out.push({
        key: 900000 + origin * 10 + i,
        from: leader,
        to: id,
        kind: 'vote',
        sentAt: origin,
        deliverAt: origin + latency,
      })
    })
  }

  return out
}

function pulsesAt(t: number, beat: Beat): PulseView[] {
  const pulses: PulseView[] = []

  for (let origin = Math.floor(t / HEARTBEAT) * HEARTBEAT - HEARTBEAT * 2; origin <= t; origin += HEARTBEAT) {
    if (origin < 0 || beat.down === beat.leader) continue
    pulses.push({ key: `hb-${origin}`, node: IDS[beat.leader], kind: 'heartbeat', at: origin })
  }

  for (const b of SCRIPT) {
    if (b.at > t || t - b.at > 40) continue
    if (b.note?.tone === 'leader' && b.note.text.includes('elected')) {
      pulses.push({ key: `el-${b.at}`, node: IDS[b.leader], kind: 'elected', at: b.at })
    }
    if (b.note?.tone === 'good' && b.note.text.startsWith('commit')) {
      pulses.push({ key: `cm-${b.at}`, node: IDS[b.leader], kind: 'commit', at: b.at })
    }
  }

  return pruneEffects(pulses, t)
}

function dropsAt(t: number, beat: Beat): DropView[] {
  if (beat.down === undefined) return []

  // While a node is down, traffic aimed at it disintegrates.
  const drops: DropView[] = []
  for (let origin = Math.floor(t / HEARTBEAT) * HEARTBEAT - HEARTBEAT; origin <= t; origin += HEARTBEAT) {
    if (origin < 0 || beat.down === beat.leader) continue
    drops.push({
      key: `dr-${origin}`,
      from: IDS[beat.leader],
      to: IDS[beat.down],
      at: origin + 3,
      cause: 'node-down',
    })
  }
  return pruneEffects(drops, t)
}

function eventsUpTo(t: number): EventView[] {
  const events: EventView[] = []
  const loops = Math.floor(t / CYCLE)

  for (let loop = 0; loop <= loops; loop++) {
    for (const beat of SCRIPT) {
      const at = loop * CYCLE + beat.at
      if (at > t || !beat.note) continue
      events.push({ key: `${loop}-${beat.at}`, tick: at, text: beat.note.text, tone: beat.note.tone })
    }
  }

  return events.slice(-EVENT_CAP)
}

export function createMockFeed(): Feed {
  return {
    kind: 'mock',
    seek(time: number): ViewState {
      const t = ((time % CYCLE) + CYCLE) % CYCLE
      const beat = beatAt(t)

      const nodes: NodeView[] = IDS.map((id, i) => ({
        id,
        role: roleOf(i, beat, t),
        term: beat.down === i ? beat.term - 1 : beat.term,
        alive: beat.down !== i,
        commitIndex: beat.committed,
        log: logFor(i, beat),
      }))

      return {
        time,
        tick: Math.floor(time),
        term: beat.term,
        commitIndex: beat.committed,
        phase: beat.phase,
        nodes,
        partition: null,
        messages: messagesAt(t, beat),
        pulses: pulsesAt(t, beat),
        drops: dropsAt(t, beat),
        events: eventsUpTo(time),
      }
    },
  }
}

export const MOCK_CYCLE_TICKS = CYCLE
