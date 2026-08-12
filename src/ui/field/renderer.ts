import type { NodeId } from '../../raft/types'
import type { ViewState } from '../viewModel'

/**
 * The node field, behind one interface.
 *
 * Two implementations: the 2D canvas renderer, which is the default, and a
 * WebGL one behind `?field=webgl`. Both consume the same `ViewState` and share
 * the geometry in `geometry.ts` — the ring layout, the bezier arcs, and the
 * rift crossing are computed once and used by both, so a message dies at the
 * same point on the same arc whichever renderer is drawing it.
 *
 * Neither owns any animation state. Every phase comes from `state.time` minus
 * the timestamp on the effect, which is what lets the feed be scrubbed.
 */

export interface DrawOptions {
  readonly reducedMotion: boolean
}

export interface FieldRenderer {
  readonly kind: FieldKind
  /** CSS pixel size plus device pixel ratio. Called on mount and on resize. */
  resize(width: number, height: number, dpr: number): void
  draw(state: ViewState, options: DrawOptions): void
  /** Which node is under this CSS-pixel point, for click-to-kill. */
  pick(state: ViewState, x: number, y: number): NodeId | null
  dispose(): void
}

export type FieldKind = 'canvas' | 'webgl'

/**
 * The canvas renderer is the default and stays the default. WebGL is opt-in per
 * page load, so a broken GPU path can never take the instrument down.
 */
export function fieldKindFromLocation(search: string): FieldKind {
  return new URLSearchParams(search).get('field') === 'webgl' ? 'webgl' : 'canvas'
}
