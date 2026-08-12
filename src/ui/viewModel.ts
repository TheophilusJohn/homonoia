import type { NodeId, Role } from '../raft/types'

/**
 * What the render layer consumes.
 *
 * A ViewState is a *pure snapshot at a point in time*, including transient
 * effects. Every effect carries the tick it happened on rather than being fired
 * as a one-shot signal, so the renderer derives its animation from
 * `time - effect.at` and holds no hidden state of its own.
 *
 * That is what makes a feed scrubbable. If pulses and drops were emitted as
 * events the renderer had to latch onto, seeking backwards would leave the
 * screen showing effects that had not happened yet, and seeking forwards would
 * silently skip them.
 *
 * Nothing here imports from src/ui. The dependency direction is
 * ui -> sim -> raft, and this module is the seam.
 */

export type CellState =
  | 'uncommitted'
  | 'committed'
  /** Conflicts with the leader's log at this index — about to be truncated. */
  | 'divergent'
  /** Already truncated. Kept in the view briefly so the removal can be seen. */
  | 'truncated'

export interface LogCellView {
  readonly index: number
  readonly term: number
  readonly state: CellState
  readonly label: string
  /**
   * Tick at which this cell first became committed, if it has.
   *
   * The crystallize wave is derived from this rather than from a render-time
   * diff, for the same reason pulses carry timestamps: a diff cannot survive a
   * scrub, and it forces the component to hold state the snapshot already
   * describes.
   */
  readonly committedAt?: number
  /** Tick this entry was truncated away, for the shatter. */
  readonly truncatedAt?: number
}

export interface NodeView {
  readonly id: NodeId
  readonly role: Role
  readonly term: number
  readonly alive: boolean
  readonly commitIndex: number
  readonly log: readonly LogCellView[]
}

/** AppendEntries traffic reads leader-amber; RequestVote traffic reads candidate-violet. */
export type MessageKind = 'append' | 'vote'

export interface MessageView {
  /** Stable across frames — the bus sequence number. */
  readonly key: number
  readonly from: NodeId
  readonly to: NodeId
  readonly kind: MessageKind
  readonly sentAt: number
  readonly deliverAt: number
}

export type PulseKind =
  /** Leader heartbeat: the slow ring only a leader emits. */
  | 'heartbeat'
  /** A node took delivery of something. */
  | 'receive'
  /** Cinematic: a leader was elected. */
  | 'elected'
  /** Cinematic: the commit index advanced. */
  | 'commit'

export interface PulseView {
  readonly key: string
  readonly node: NodeId
  readonly kind: PulseKind
  readonly at: number
}

/**
 * A message that died in transit.
 *
 * The *cause* is carried rather than a baked-in position, because where a
 * message dies is geometry and geometry belongs to the renderer: a partition
 * drop has to disintegrate where its arc crosses the rift, and only the render
 * layer knows where the rift is.
 */
export type DropCause = 'random' | 'partition' | 'node-down'

export interface DropView {
  readonly key: string
  readonly from: NodeId
  readonly to: NodeId
  readonly at: number
  readonly cause: DropCause
}

export type EventTone = 'normal' | 'leader' | 'good' | 'warn'

export interface EventView {
  readonly key: string
  readonly tick: number
  readonly text: string
  readonly tone: EventTone
}

export interface ViewState {
  /** Continuous tick time — fractional between ticks, which is what messages interpolate on. */
  readonly time: number
  readonly tick: number
  readonly term: number
  readonly commitIndex: number
  readonly phase: string
  readonly nodes: readonly NodeView[]
  /** Groups that can reach each other, or null when the network is whole. */
  readonly partition: readonly (readonly NodeId[])[] | null
  readonly messages: readonly MessageView[]
  readonly pulses: readonly PulseView[]
  readonly drops: readonly DropView[]
  readonly events: readonly EventView[]
}

/**
 * A source of view states.
 *
 * `seek` is absolute so a feed can be scrubbed. The mock is a pure function of
 * time; the sim feed replays from its seed when asked to go backwards, which it
 * can do because a seed reproduces a run exactly.
 */
export interface Feed {
  readonly kind: 'mock' | 'sim'
  seek(time: number): ViewState
}

/** Effects older than this are dropped from the snapshot; nothing animates longer. */
export const EFFECT_WINDOW_TICKS = 40

export function pruneEffects<T extends { at: number }>(items: readonly T[], now: number): T[] {
  return items.filter((item) => now - item.at <= EFFECT_WINDOW_TICKS)
}

/** Newest last, capped — the event stream shows the tail. */
export const EVENT_CAP = 26
