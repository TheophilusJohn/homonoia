import { useCallback, useEffect, useRef, useState } from 'react'

import type { NodeId } from '../raft/types'
import { Controls } from './Controls'
import type { ControlValues } from './Controls'
import { EventStream } from './EventStream'
import { Ledger } from './Ledger'
import { createMockFeed, MOCK_CYCLE_TICKS } from './mockFeed'
import { NodeField } from './NodeField'
import { createSimFeed } from './simFeed'
import type { SimFeed } from './simFeed'
import type { Feed, ViewState } from './viewModel'

/** Ticks per wall-clock second at 1× — fast enough that a message crossing reads as transit. */
const TICKS_PER_SECOND = 20

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const listener = (e: MediaQueryListEvent) => setReduced(e.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  return reduced
}

export function Observatory() {
  const reducedMotion = usePrefersReducedMotion()

  const [controls, setControls] = useState<ControlValues>({
    playing: true,
    speed: 1,
    latency: 4,
    dropPercent: 0,
    seed: 20260811,
  })
  const [feedKind, setFeedKind] = useState<'sim' | 'mock'>('sim')

  // Created once. The run is reconfigured in place when seed, latency or drop
  // rate change; speed and playback never rebuild it.
  const [simFeed] = useState<SimFeed>(() =>
    createSimFeed({ seed: 20260811, latency: 4, dropPercent: 0 }),
  )
  const [mockFeed] = useState<Feed>(() => createMockFeed())
  const feed: Feed = feedKind === 'sim' ? simFeed : mockFeed

  const timeRef = useRef(0)
  const [state, setState] = useState<ViewState>(() => simFeed.seek(0))

  // Live values for the animation loop, which must not re-subscribe every frame.
  const controlsRef = useRef(controls)
  const feedRef = useRef(feed)

  useEffect(() => {
    controlsRef.current = controls
    feedRef.current = feed
  })

  useEffect(() => {
    let frame = 0
    let last = performance.now()

    const loop = (now: number) => {
      // Clamped so a backgrounded tab does not resume by fast-forwarding.
      const dt = Math.min(now - last, 100)
      last = now

      if (controlsRef.current.playing) {
        timeRef.current += (dt / 1000) * TICKS_PER_SECOND * controlsRef.current.speed
      }
      setState(feedRef.current.seek(timeRef.current))
      frame = requestAnimationFrame(loop)
    }

    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [])

  const applyControls = useCallback(
    (patch: Partial<ControlValues>) => {
      setControls((current) => {
        const next = { ...current, ...patch }

        // Latency, drop rate and seed change the run itself, so the sim is
        // rebuilt from the seed and time restarts. Speed and playback do not.
        const rerun =
          patch.latency !== undefined || patch.dropPercent !== undefined || patch.seed !== undefined
        if (rerun) {
          simFeed.configure({
            seed: next.seed,
            latency: next.latency,
            dropPercent: next.dropPercent,
          })
          timeRef.current = 0
        }
        return next
      })
    },
    [simFeed],
  )

  const step = useCallback(() => {
    timeRef.current = Math.floor(timeRef.current) + 1
    setState(feedRef.current.seek(timeRef.current))
  }, [])

  const scrubTo = useCallback((time: number) => {
    timeRef.current = time
    setState(feedRef.current.seek(time))
  }, [])

  const toggleNode = useCallback(
    (id: NodeId) => {
      if (feedKind !== 'sim') return
      simFeed.toggleNode(id)
    },
    [feedKind, simFeed],
  )

  const toggleFeed = useCallback(() => {
    setFeedKind((current) => (current === 'sim' ? 'mock' : 'sim'))
    timeRef.current = 0
  }, [])

  return (
    <div className="app">
      <header className="head">
        <div className="mark">
          Homo<em>noia</em>
        </div>
        <div className="tag">Raft consensus · observatory</div>

        <div className="hstats">
          <div className="stat">
            <span>Phase</span>
            <span className="phase" data-phase={state.phase}>
              {state.phase}
            </span>
          </div>
          <div className="stat">
            <span>Term</span>
            <span>{state.term}</span>
          </div>
          <div className="stat">
            <span>Commit</span>
            <span>{state.commitIndex}</span>
          </div>
          <div className="stat">
            <span>Tick</span>
            <span>{String(state.tick).padStart(4, '0')}</span>
          </div>
        </div>
      </header>

      <main className="main">
        <div className="field">
          <NodeField state={state} reducedMotion={reducedMotion} onNodeClick={toggleNode} />
          {feedKind === 'mock' && <div className="feedbadge">Mock feed</div>}
          <div className="hint">
            {feedKind === 'sim' ? 'Click a node to kill or revive it' : 'Scripted feed · scrub to inspect'}
          </div>
        </div>

        <aside className="side">
          <div className="sec">
            <h2>Replicated log</h2>
          </div>
          <Ledger nodes={state.nodes} time={state.time} />
          <div className="sec">
            <h2>Event stream</h2>
          </div>
          <EventStream events={state.events} />
        </aside>
      </main>

      <Controls
        values={controls}
        feedKind={feedKind}
        scrub={feedKind === 'mock' ? { time: state.time, cycle: MOCK_CYCLE_TICKS } : undefined}
        onChange={applyControls}
        onStep={step}
        onSubmit={() => simFeed.submitCommand()}
        onScrub={scrubTo}
        onToggleFeed={toggleFeed}
      />
    </div>
  )
}
