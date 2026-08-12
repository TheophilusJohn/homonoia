import type { NodeView } from './viewModel'

/**
 * The replicated log, one row per node.
 *
 * DOM, not canvas: the entries are text and must stay selectable and reachable
 * by a screen reader.
 *
 * The crystallize wave is the project's signature. When an entry commits, each
 * row plays it 70ms after the one above, so the transition reads as a wave
 * sweeping down the cluster rather than five things blinking at once. That is
 * the moment Raft's central guarantee becomes visible, so everything else in
 * the UI stays quiet to let it land.
 *
 * The wave is derived from each cell's `committedAt` rather than from a render
 * diff, so the component holds no state — scrubbing the feed backwards replays
 * it correctly instead of leaving stale animations behind.
 */

const STAGGER_MS = 70

/**
 * How long a cell counts as freshly committed, in ticks.
 *
 * Generous on purpose: the animation is wall-clock (550ms plus stagger) while
 * this window is measured in ticks, and a tick is shorter at higher speeds. Set
 * to cover the animation even at the fastest playback. Overshooting only means
 * the class lingers after the animation has already settled, which is
 * invisible; undershooting would cut the wave off mid-sweep.
 */
const FRESH_TICKS = 45

interface Props {
  readonly nodes: readonly NodeView[]
  readonly time: number
}

export function Ledger({ nodes, time }: Props) {
  return (
    <div className="ledger">
      {nodes.map((node, row) => (
        <div className="row" key={node.id}>
          <div className="rid">
            <i className="dot" data-role={node.alive ? node.role : 'dead'} />
            <b>{node.id}</b>
          </div>

          <div className="cells">
            {node.log.map((cell) => {
              const age = cell.committedAt === undefined ? Infinity : time - cell.committedAt
              const fresh = age >= 0 && age < FRESH_TICKS
              const gone = cell.state === 'truncated'

              return (
                <div
                  key={`${cell.index}-${cell.state}`}
                  className={`cell${fresh ? ' crystallize' : ''}${gone ? ' shatter' : ''}`}
                  data-state={cell.state}
                  style={fresh ? { animationDelay: `${row * STAGGER_MS}ms` } : undefined}
                  title={gone ? 'truncated' : `index ${cell.index} · term ${cell.term}`}
                >
                  {cell.label}
                </div>
              )
            })}
          </div>

          <div className="rowmeta">{node.alive ? `t${node.term}` : 'down'}</div>
        </div>
      ))}
    </div>
  )
}
