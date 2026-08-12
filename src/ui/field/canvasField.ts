import type { NodeId } from '../../raft/types'
import type { ViewState } from '../viewModel'
import { nodeAtPoint, render } from './render'
import type { DrawOptions, FieldRenderer } from './renderer'

/**
 * The 2D canvas field, behind the common interface.
 *
 * The drawing itself is unchanged and still lives in render.ts; this only holds
 * the size and the context so both renderers can be driven the same way.
 */
export function createCanvasField(canvas: HTMLCanvasElement): FieldRenderer {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')

  let width = 0
  let height = 0

  return {
    kind: 'canvas',

    resize(nextWidth: number, nextHeight: number, dpr: number): void {
      width = nextWidth
      height = nextHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    },

    draw(state: ViewState, options: DrawOptions): void {
      render(ctx, state, { width, height, reducedMotion: options.reducedMotion })
    },

    pick(state: ViewState, x: number, y: number): NodeId | null {
      return nodeAtPoint(state, x, y, width, height)
    },

    dispose(): void {},
  }
}
