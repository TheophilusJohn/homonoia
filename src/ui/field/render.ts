import type { NodeId } from '../../raft/types'
import type { MessageKind, NodeView, ViewState } from '../viewModel'
import { arcControl, arcCrossing, arcPoint, jitter, NODE_RADIUS, riftBetween, ringLayout } from './geometry'
import type { Point, Rift } from './geometry'

/**
 * The node field.
 *
 * One clearRect, one switch into additive blending for everything that emits
 * light, one switch back. The renderer is a pure function of (ViewState,
 * canvas) — every animation phase comes from `state.time` minus the timestamp
 * on the effect, so scrubbing the feed backwards rewinds the picture exactly.
 */

const RGB = {
  leader: '229,162,60',
  cand: '155,140,240',
  follow: '88,98,121',
  oxide: '194,84,56',
  ink: '232,227,214',
} as const

/** Ticks. Instrument layer: a trail is a short memory, not a comet tail. */
const TRAIL_SAMPLES = 7
const TRAIL_SPACING = 0.026

export interface RenderOptions {
  readonly width: number
  readonly height: number
  /** Collapse every animation to its resting state. */
  readonly reducedMotion: boolean
}

function roleRgb(node: NodeView): string {
  if (!node.alive) return RGB.follow
  if (node.role === 'leader') return RGB.leader
  if (node.role === 'candidate') return RGB.cand
  return RGB.follow
}

function messageRgb(kind: MessageKind): string {
  return kind === 'vote' ? RGB.cand : RGB.leader
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: ViewState,
  options: RenderOptions,
): void {
  const { width, height, reducedMotion } = options
  const ids = state.nodes.map((node) => node.id)
  const layout = ringLayout(ids, width, height)
  const centre: Point = { x: width / 2, y: height / 2 }
  const at = (id: NodeId): Point => layout.get(id) ?? centre

  const rift = state.partition ? riftBetween(state.partition, layout) : null

  ctx.clearRect(0, 0, width, height)

  drawIdleLinks(ctx, ids, at, centre, state)
  if (rift) drawRift(ctx, rift, state, width, height, reducedMotion)

  ctx.globalCompositeOperation = 'lighter'
  drawPulses(ctx, state, at, reducedMotion)
  drawMessages(ctx, state, at, centre, reducedMotion)
  drawDrops(ctx, state, at, centre, rift, reducedMotion)
  ctx.globalCompositeOperation = 'source-over'

  drawNodes(ctx, state, at, reducedMotion)
}

/** Which group a node is in, or -1 when the network is whole. */
function groupOf(state: ViewState, id: NodeId): number {
  if (!state.partition) return -1
  return state.partition.findIndex((group) => group.includes(id))
}

function severed(state: ViewState, a: NodeId, b: NodeId): boolean {
  if (!state.partition) return false
  return groupOf(state, a) !== groupOf(state, b)
}

/**
 * The rift: an animated dashed line along the perpendicular bisector between
 * the two group centroids, with a soft oxide wash either side.
 *
 * A partition opening is one of the four cinematic moments, so this is allowed
 * to be the loudest thing on screen while it is happening.
 */
function drawRift(
  ctx: CanvasRenderingContext2D,
  rift: Rift,
  state: ViewState,
  width: number,
  height: number,
  reducedMotion: boolean,
): void {
  const reach = Math.hypot(width, height)

  ctx.save()
  ctx.translate(rift.at.x, rift.at.y)
  ctx.rotate(rift.angle)

  const wash = ctx.createLinearGradient(-26, 0, 26, 0)
  wash.addColorStop(0, 'rgba(194,84,56,0)')
  wash.addColorStop(0.5, 'rgba(194,84,56,.10)')
  wash.addColorStop(1, 'rgba(194,84,56,0)')
  ctx.fillStyle = wash
  ctx.fillRect(-26, -reach, 52, reach * 2)

  ctx.strokeStyle = 'rgba(194,84,56,.5)'
  ctx.lineWidth = 1
  ctx.setLineDash([9, 7])
  ctx.lineDashOffset = reducedMotion ? 0 : -state.time * 2.2

  ctx.beginPath()
  for (let y = -reach; y < reach; y += 9) {
    // A slight waver, so the tear reads as a fault rather than a ruled line.
    const waver = reducedMotion ? 0 : Math.sin(y * 0.05 + state.time * 0.08) * 4
    ctx.lineTo(waver, y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

/** The resting topology: every pair, barely there. */
function drawIdleLinks(
  ctx: CanvasRenderingContext2D,
  ids: readonly NodeId[],
  at: (id: NodeId) => Point,
  centre: Point,
  state: ViewState,
): void {
  ctx.lineWidth = 0.5

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const from = at(ids[i])
      const to = at(ids[j])
      const control = arcControl(from, to, centre)
      // A severed link stays visible but goes oxide: the topology is still
      // there, it just cannot carry anything.
      ctx.strokeStyle = severed(state, ids[i], ids[j])
        ? 'rgba(194,84,56,.10)'
        : 'rgba(90,100,125,.11)'
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.quadraticCurveTo(control.x, control.y, to.x, to.y)
      ctx.stroke()
    }
  }
}

function drawMessages(
  ctx: CanvasRenderingContext2D,
  state: ViewState,
  at: (id: NodeId) => Point,
  centre: Point,
  reducedMotion: boolean,
): void {
  for (const message of state.messages) {
    const span = Math.max(1, message.deliverAt - message.sentAt)
    const progress = (state.time - message.sentAt) / span
    if (progress < 0 || progress > 1) continue

    const from = at(message.from)
    const to = at(message.to)
    const rgb = messageRgb(message.kind)

    if (!reducedMotion) {
      // The trail is what makes a message emit light rather than slide.
      for (let k = 1; k < TRAIL_SAMPLES; k++) {
        const tp = Math.max(0, progress - k * TRAIL_SPACING)
        const p = arcPoint(from, to, centre, tp)
        ctx.fillStyle = `rgba(${rgb},${0.3 - k * 0.04})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.4 - k * 0.28, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const head = arcPoint(from, to, centre, progress)
    ctx.fillStyle = `rgba(${rgb},.95)`
    ctx.beginPath()
    ctx.arc(head.x, head.y, 2.7, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Dropped messages disintegrate where they died. They never simply vanish. */
function drawDrops(
  ctx: CanvasRenderingContext2D,
  state: ViewState,
  at: (id: NodeId) => Point,
  centre: Point,
  rift: Rift | null,
  reducedMotion: boolean,
): void {
  for (const drop of state.drops) {
    const age = state.time - drop.at
    if (age < 0) continue

    const life = reducedMotion ? 1 : 9
    if (age > life) continue

    const fade = 1 - age / life
    const from = at(drop.from)
    const to = at(drop.to)

    // Where it died. A message stopped by a partition dies *on the rift* — the
    // boundary is what killed it, so that is where it comes apart. Anything
    // else dies in the wire, or on arrival at a node that is not listening.
    const where =
      drop.cause === 'partition' && rift
        ? (arcCrossing(from, to, centre, rift) ?? 0.5)
        : drop.cause === 'node-down'
          ? 1
          : 0.42

    const origin = arcPoint(from, to, centre, where)

    for (let k = 0; k < 6; k++) {
      const seed = drop.key.length * 31 + k
      const spread = reducedMotion ? 3 : age * 2.2
      const x = origin.x + jitter(seed) * spread
      const y = origin.y + jitter(seed + 91) * spread + age * 0.5
      ctx.fillStyle = `rgba(${RGB.oxide},${0.45 * fade})`
      ctx.beginPath()
      ctx.arc(x, y, Math.max(0.4, 1.9 * fade), 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/**
 * Rings. Heartbeat is instrument layer — quick and quiet. Election and commit
 * are two of the four cinematic moments and are allowed to bloom.
 */
function drawPulses(
  ctx: CanvasRenderingContext2D,
  state: ViewState,
  at: (id: NodeId) => Point,
  reducedMotion: boolean,
): void {
  if (reducedMotion) return

  for (const pulse of state.pulses) {
    const age = state.time - pulse.at
    if (age < 0) continue

    const spec =
      pulse.kind === 'heartbeat'
        ? // Deliberately small. A heartbeat is instrument layer: it says "still
          // here" and then gets out of the way. Blooming it wide makes it
          // compete with the commit wave, which is the one thing that should
          // command attention.
          { life: 10, rgb: RGB.leader, from: NODE_RADIUS, grow: 1.3, alpha: 0.28, width: 1 }
        : pulse.kind === 'receive'
          ? { life: 5, rgb: RGB.ink, from: NODE_RADIUS * 0.6, grow: 1.6, alpha: 0.3, width: 0.8 }
          : pulse.kind === 'elected'
            ? { life: 26, rgb: RGB.leader, from: NODE_RADIUS, grow: 5.5, alpha: 0.75, width: 1.6 }
            : { life: 26, rgb: RGB.ink, from: NODE_RADIUS, grow: 5, alpha: 0.6, width: 1.4 }

    if (age > spec.life) continue

    const t = age / spec.life
    // Cinematic pulses ease out hard; the heartbeat is close to linear.
    const eased = pulse.kind === 'heartbeat' || pulse.kind === 'receive' ? t : 1 - (1 - t) ** 3
    const p = at(pulse.node)

    ctx.strokeStyle = `rgba(${spec.rgb},${spec.alpha * (1 - t)})`
    ctx.lineWidth = spec.width
    ctx.beginPath()
    ctx.arc(p.x, p.y, spec.from + eased * spec.from * spec.grow, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  state: ViewState,
  at: (id: NodeId) => Point,
  reducedMotion: boolean,
): void {
  for (const node of state.nodes) {
    const p = at(node.id)
    const rgb = roleRgb(node)

    if (node.alive && node.role === 'leader' && !reducedMotion) {
      const glow = ctx.createRadialGradient(p.x, p.y, NODE_RADIUS * 0.5, p.x, p.y, NODE_RADIUS * 3.2)
      glow.addColorStop(0, `rgba(${rgb},.13)`)
      glow.addColorStop(1, `rgba(${rgb},0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(p.x, p.y, NODE_RADIUS * 3.2, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = node.alive ? '#0F131C' : '#0A0C12'
    ctx.beginPath()
    ctx.arc(p.x, p.y, NODE_RADIUS, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = node.alive ? `rgba(${rgb},.6)` : 'rgba(60,68,88,.5)'
    ctx.lineWidth = node.alive ? 1.2 : 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, NODE_RADIUS, 0, Math.PI * 2)
    ctx.stroke()

    // Only a leader carries the breathing halo.
    if (node.alive && node.role === 'leader') {
      const wobble = reducedMotion ? 0 : Math.sin(state.time * 0.5) * 1.6
      ctx.strokeStyle = `rgba(${rgb},.22)`
      ctx.lineWidth = 0.7
      ctx.beginPath()
      ctx.arc(p.x, p.y, NODE_RADIUS + 7 + wobble, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '500 15px "IBM Plex Mono", monospace'
    ctx.fillStyle = node.alive ? '#E8E3D6' : '#3E4659'
    ctx.fillText(node.id.replace(/^n/, ''), p.x, p.y - 1)

    ctx.font = '400 9.5px "IBM Plex Mono", monospace'
    ctx.fillStyle = node.alive ? `rgba(${rgb},.9)` : 'rgba(62,70,89,.9)'
    const caption = !node.alive
      ? 'DOWN'
      : node.role === 'leader'
        ? 'LEADER'
        : node.role === 'candidate'
          ? 'CAND'
          : `t${node.term}`
    ctx.fillText(caption, p.x, p.y + NODE_RADIUS + 13)
  }
}

/** Which node, if any, is under this point. For click-to-kill. */
export function nodeAtPoint(
  state: Pick<ViewState, 'nodes'>,
  x: number,
  y: number,
  width: number,
  height: number,
): NodeId | null {
  const layout = ringLayout(
    state.nodes.map((node) => node.id),
    width,
    height,
  )

  for (const [id, p] of layout) {
    if (Math.hypot(p.x - x, p.y - y) <= NODE_RADIUS + 4) return id
  }
  return null
}
