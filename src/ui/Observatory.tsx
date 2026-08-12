import { useCallback, useEffect, useRef, useState } from 'react'

import type { NodeId } from '../raft/types'
import { ringLayout } from './field/geometry'
import { Controls } from './Controls'
import type { ControlValues } from './Controls'
import { castFor, DEMO } from './demo'
import { EventStream } from './EventStream'
import { Ledger } from './Ledger'
import { createMockFeed, MOCK_CYCLE_TICKS } from './mockFeed'
import { NodeField } from './NodeField'
import { hrefFor, navigate, shouldIntercept } from './router'
import { createSimFeed } from './simFeed'
import type { SimFeed } from './simFeed'
import type { Feed, ViewState } from './viewModel'

/** Ticks per wall-clock second at 1× — fast enough that a message crossing reads as transit. */
const TICKS_PER_SECOND = 20

const IDS: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

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
    load: true,
  })
  const [feedKind, setFeedKind] = useState<'sim' | 'mock'>('sim')
  const [partitionMode, setPartitionMode] = useState(false)
  /** Nodes moved to the far side of the rift while cutting. */
  const [cutSide, setCutSide] = useState<readonly NodeId[]>([])
  const [demoStep, setDemoStep] = useState<number | null>(null)
  const [caption, setCaption] = useState<string | null>(null)

  // Created once. The run is reconfigured in place when seed, latency or drop
  // rate change; speed and playback never rebuild it.
  const [simFeed] = useState<SimFeed>(() =>
    createSimFeed({ seed: 20260811, latency: 4, dropPercent: 0, commandEvery: 22 }),
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
            commandEvery: next.load ? 22 : 0,
          })
          timeRef.current = 0
        } else if (patch.load !== undefined) {
          // Toggling load must not restart the run.
          simFeed.setLoad(next.load ? 22 : 0)
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

  // --- Partition selection ---

  const applyCut = useCallback(
    (side: readonly NodeId[]) => {
      setCutSide(side)
      if (side.length === 0 || side.length === IDS.length) simFeed.heal()
      else simFeed.partition([IDS.filter((id) => !side.includes(id)), [...side]])
    },
    [simFeed],
  )

  const heal = useCallback(() => {
    setCutSide([])
    setPartitionMode(false)
    simFeed.heal()
  }, [simFeed])

  const togglePartitionMode = useCallback(() => {
    setPartitionMode((current) => !current)
  }, [])

  /** A drag across the field cuts the cluster along the line drawn. */
  const cutAlong = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }, width: number, height: number) => {
      const layout = ringLayout(IDS, width, height)
      const dx = to.x - from.x
      const dy = to.y - from.y
      if (Math.hypot(dx, dy) < 24) return

      const side = IDS.filter((id) => {
        const p = layout.get(id)!
        // Sign of the cross product: which side of the drawn line it falls on.
        return (p.x - from.x) * dy - (p.y - from.y) * dx > 0
      })
      applyCut(side)
    },
    [applyCut],
  )

  const toggleNode = useCallback(
    (id: NodeId) => {
      if (feedKind !== 'sim') return

      // In partition mode a click moves a node across the rift instead of
      // killing it — one gesture, two meanings, so the mode has to be visible.
      if (partitionMode) {
        applyCut(cutSide.includes(id) ? cutSide.filter((other) => other !== id) : [...cutSide, id])
        return
      }
      simFeed.toggleNode(id)
    },
    [applyCut, cutSide, feedKind, partitionMode, simFeed],
  )

  // --- The scripted demo ---
  //
  // Driven off the sim's own tick count rather than wall time, so it keeps its
  // shape at any playback speed.
  const demoRef = useRef<{ cast: ReturnType<typeof castFor>; nextAt: number; index: number } | null>(
    null,
  )

  const startDemo = useCallback(() => {
    if (demoRef.current) {
      demoRef.current = null
      setDemoStep(null)
      setCaption(null)
      return
    }

    const leader = simFeed.leaderId()
    if (!leader) {
      setCaption('Waiting for a leader before the demo can start')
      return
    }

    // The demo owns every write while it runs.
    setControls((current) => ({ ...current, load: false, playing: true }))
    simFeed.setLoad(0)
    simFeed.heal()

    demoRef.current = {
      cast: castFor(leader, IDS),
      nextAt: simFeed.sim.now,
      index: 0,
    }
    setDemoStep(0)
  }, [simFeed])

  useEffect(() => {
    if (demoStep === null) return
    let frame = 0

    const pump = () => {
      const run = demoRef.current
      if (run) {
        while (run.index < DEMO.length && simFeed.sim.now >= run.nextAt + DEMO[run.index].after) {
          const step = DEMO[run.index]
          run.nextAt += step.after
          step.run(simFeed, run.cast)
          setCaption(step.caption)
          setDemoStep(run.index)
          run.index += 1
        }
        if (run.index >= DEMO.length) {
          demoRef.current = null
          setDemoStep(null)
        }
      }
      frame = requestAnimationFrame(pump)
    }

    frame = requestAnimationFrame(pump)
    return () => cancelAnimationFrame(frame)
  }, [demoStep, simFeed])

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
        <a
          className="tag head-link"
          href={hrefFor('/about')}
          onClick={(event) => {
            if (!shouldIntercept(event)) return
            event.preventDefault()
            navigate('/about')
          }}
        >
          What is this?
        </a>

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
        <div className="field" data-mode={partitionMode ? 'partition' : undefined}>
          <NodeField
            state={state}
            reducedMotion={reducedMotion}
            onNodeClick={toggleNode}
            onDrag={partitionMode ? cutAlong : undefined}
          />
          {feedKind === 'mock' && <div className="feedbadge">Mock feed</div>}
          <div className={`banner${state.partition ? ' on' : ''}`}>
            {state.partition
              ? `Network partitioned · ${state.partition.map((g) => g.length).join(' ⁄ ')}`
              : ''}
          </div>
          <div className="hint">
            {caption ??
              (feedKind !== 'sim'
                ? 'Scripted feed · scrub to inspect'
                : partitionMode
                  ? 'Click nodes to move them across the rift, or drag to cut'
                  : 'Click a node to kill or revive it')}
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
        partitionMode={partitionMode}
        partitioned={state.partition !== null}
        demoRunning={demoStep !== null}
        onPartitionMode={togglePartitionMode}
        onHeal={heal}
        onDemo={startDemo}
      />
    </div>
  )
}
