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

interface Props {
  readonly state: ViewState
  readonly reducedMotion: boolean
  readonly onNodeClick: (id: NodeId) => void
}

export function NodeField({ state, reducedMotion, onNodeClick }: Props) {
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

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const id = nodeAtPoint(
      stateRef.current,
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
    )
    if (id) onNodeClick(id)
  }

  return <canvas ref={canvasRef} onClick={handleClick} />
}
