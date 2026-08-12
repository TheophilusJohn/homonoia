import type { NodeId } from '../../raft/types'

export interface Point {
  readonly x: number
  readonly y: number
}

export const NODE_RADIUS = 22

/**
 * Five nodes on a ring, first at twelve o'clock.
 *
 * A ring, not a row: every node is equidistant from the centre, so no node
 * reads as more important than another until its state says so.
 */
export function ringLayout(ids: readonly NodeId[], width: number, height: number): Map<NodeId, Point> {
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) * 0.31

  return new Map(
    ids.map((id, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ids.length
      return [id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }]
    }),
  )
}

/**
 * Point along the quadratic bezier between two nodes, pulled 22% toward centre.
 *
 * Straight lines read as wires — a fixed topology. Arcs read as transit,
 * something moving through space. The pull is what makes a message look like it
 * is crossing the cluster rather than riding a cable.
 */
export function arcPoint(from: Point, to: Point, centre: Point, t: number): Point {
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const qx = mx + (centre.x - mx) * 0.22
  const qy = my + (centre.y - my) * 0.22
  const u = 1 - t

  return {
    x: u * u * from.x + 2 * u * t * qx + t * t * to.x,
    y: u * u * from.y + 2 * u * t * qy + t * t * to.y,
  }
}

export function arcControl(from: Point, to: Point, centre: Point): Point {
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  return { x: mx + (centre.x - mx) * 0.22, y: my + (centre.y - my) * 0.22 }
}

/** Deterministic scatter for particles — same drop always shatters the same way. */
export function jitter(seed: number): number {
  const x = Math.sin(seed * 127.1) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

/**
 * The rift: the perpendicular bisector between the two group centroids.
 *
 * Computed from the groups, never hardcoded — split the cluster any way and the
 * line falls where the split actually is.
 */
export interface Rift {
  /** Midpoint between the centroids: the line passes through here. */
  readonly at: Point
  /** Unit normal, pointing from group A's centroid toward group B's. */
  readonly normal: Point
  /**
   * Rotation to apply before drawing the rift.
   *
   * This is the angle of the *normal*, not of the line. Rotating by it maps the
   * local Y axis onto (-normal.y, normal.x), which is perpendicular to the
   * normal — so a line drawn down local Y is the bisector. Adding a further
   * quarter turn, which reads as the intuitive fix, lays the line along the
   * normal instead and produces a rift parallel to the split rather than
   * across it.
   */
  readonly angle: number
}

function centroid(points: readonly Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}

export function riftBetween(
  groups: readonly (readonly NodeId[])[],
  layout: Map<NodeId, Point>,
): Rift | null {
  // Meaningful only for a two-way split where both sides have somewhere to be.
  if (groups.length !== 2) return null

  const sides = groups.map((group) =>
    group.map((id) => layout.get(id)).filter((p): p is Point => p !== undefined),
  )
  if (sides[0].length === 0 || sides[1].length === 0) return null

  const a = centroid(sides[0])
  const b = centroid(sides[1])
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return null

  return {
    at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    normal: { x: dx / length, y: dy / length },
    angle: Math.atan2(dy, dx),
  }
}

/** Signed distance from the rift line — sign tells you which side you are on. */
export function sideOf(rift: Rift, p: Point): number {
  return (p.x - rift.at.x) * rift.normal.x + (p.y - rift.at.y) * rift.normal.y
}

/**
 * Where along the arc from `from` to `to` it crosses the rift, or null.
 *
 * The arc is a quadratic bezier, so its signed distance from the rift line is a
 * quadratic in t — solved exactly rather than sampled, so the disintegration
 * lands on the line instead of near it.
 */
export function arcCrossing(from: Point, to: Point, centre: Point, rift: Rift): number | null {
  const control = arcControl(from, to, centre)
  const n = rift.normal

  // d(t) = a t^2 + b t + c, the signed distance of B(t) from the line.
  const c = (from.x - rift.at.x) * n.x + (from.y - rift.at.y) * n.y
  const b = 2 * ((control.x - from.x) * n.x + (control.y - from.y) * n.y)
  const a = (from.x - 2 * control.x + to.x) * n.x + (from.y - 2 * control.y + to.y) * n.y

  const roots: number[] = []
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc < 0) return null
    const root = Math.sqrt(disc)
    roots.push((-b + root) / (2 * a), (-b - root) / (2 * a))
  }

  const inside = roots.filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y)
  return inside.length > 0 ? inside[0] : null
}
