import { useEffect, useRef } from 'react'

import type { NodeId } from '../raft/types'
import { createCanvasField } from './field/canvasField'
import { fieldKindFromLocation } from './field/renderer'
import type { FieldKind, FieldRenderer } from './field/renderer'
import type { ViewState } from './viewModel'

/**
 * The canvas. React owns the element; the draw loop owns the pixels.
 *
 * The latest ViewState goes into a ref rather than driving re-renders, so the
 * field runs at rAF regardless of how often the feed produces a frame, and
 * React never re-renders on a per-frame basis.
 */

interface Point {
  readonly x: number
  readonly y: number
}

interface Props {
  readonly state: ViewState
  readonly reducedMotion: boolean
  readonly onNodeClick: (id: NodeId) => void
  /** When set, a drag across the field cuts the cluster along the line drawn. */
  readonly onDrag?: (from: Point, to: Point, width: number, height: number) => void
}

/**
 * Which field renderer to use. Read once per page load: switching mid-run would
 * mean tearing down a GL context on a live frame for no benefit.
 */
const FIELD_KIND: FieldKind = fieldKindFromLocation(window.location.search)

export function NodeField({ state, reducedMotion, onNodeClick, onDrag }: Props) {
  const dragFrom = useRef<Point | null>(null)
  const fieldRef = useRef<FieldRenderer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef(state)
  const motionRef = useRef(reducedMotion)

  useEffect(() => {
    stateRef.current = state
    motionRef.current = reducedMotion
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let field: FieldRenderer | null = null
    let disposed = false
    let frame = 0

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      // DPR capped at 2 — beyond that costs fill rate for nothing visible.
      field?.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2))
    }

    const observer = new ResizeObserver(resize)
    if (canvas.parentElement) observer.observe(canvas.parentElement)

    const adopt = (next: FieldRenderer) => {
      if (disposed) {
        next.dispose()
        return
      }
      field = next
      fieldRef.current = next
      resize()
    }

    /**
     * A canvas element is bound to the first context type it is asked for, for
     * life. Taking a 2d context to draw something while three.js loads would
     * permanently deny the same element a WebGL one — so when the flag is set
     * nothing is created until the module resolves, and the canvas renderer is
     * built only if it does not.
     *
     * three.js is ~550kB and only the opt-in field needs it, so the default
     * path never downloads it.
     */
    if (FIELD_KIND === 'webgl') {
      void import('./field/webglField')
        .then(({ createWebglField }) => adopt(createWebglField(canvas)))
        .catch((error: unknown) => {
          console.warn('WebGL field unavailable, falling back to canvas', error)
          adopt(createCanvasField(canvas))
        })
    } else {
      adopt(createCanvasField(canvas))
    }

    const loop = () => {
      field?.draw(stateRef.current, { reducedMotion: motionRef.current })
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      field?.dispose()
      fieldRef.current = null
    }
  }, [])

  const local = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { point: { x: event.clientX - rect.left, y: event.clientY - rect.top }, rect }
  }

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onDrag) return
    dragFrom.current = local(event).point
  }

  const handleMouseUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const start = dragFrom.current
    dragFrom.current = null
    if (!onDrag || !start) return

    const { point, rect } = local(event)
    // A short drag is a click; anything longer is a cut.
    if (Math.hypot(point.x - start.x, point.y - start.y) < 24) return
    onDrag(start, point, rect.width, rect.height)
  }

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { point } = local(event)
    const id = fieldRef.current?.pick(stateRef.current, point.x, point.y)
    if (id) onNodeClick(id)
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    />
  )
}
