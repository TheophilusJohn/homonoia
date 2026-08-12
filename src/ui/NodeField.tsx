import { useEffect, useRef } from 'react'

import type { NodeId } from '../raft/types'
import { nodeAtPoint, render } from './field/render'
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

export function NodeField({ state, reducedMotion, onNodeClick, onDrag }: Props) {
  const dragFrom = useRef<Point | null>(null)
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
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let frame = 0
    let width = 0
    let height = 0

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      // DPR capped at 2 — beyond that costs fill rate for nothing visible.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const observer = new ResizeObserver(resize)
    if (canvas.parentElement) observer.observe(canvas.parentElement)

    const loop = () => {
      render(ctx, stateRef.current, { width, height, reducedMotion: motionRef.current })
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
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
    const { point, rect } = local(event)
    const id = nodeAtPoint(stateRef.current, point.x, point.y, rect.width, rect.height)
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
