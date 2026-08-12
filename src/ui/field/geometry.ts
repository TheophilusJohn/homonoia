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
