/**
 * The instrument's controls. Everything that changes the run lives here;
 * nothing here animates beyond the 180ms button feedback.
 */

export interface ControlValues {
  readonly playing: boolean
  readonly speed: number
  readonly latency: number
  readonly dropPercent: number
  readonly seed: number
  /** Background client traffic. The demo turns it off so it controls every write. */
  readonly load: boolean
}

interface Props {
  readonly values: ControlValues
  readonly feedKind: 'mock' | 'sim'
  /** Mock only: scrub position and cycle length, for iterating on the render layer. */
  readonly scrub?: { readonly time: number; readonly cycle: number }
  readonly onChange: (patch: Partial<ControlValues>) => void
  readonly onStep: () => void
  readonly onSubmit: () => void
  readonly onScrub?: (time: number) => void
  readonly onToggleFeed: () => void
  readonly partitionMode: boolean
  readonly partitioned: boolean
  readonly demoRunning: boolean
  readonly onPartitionMode: () => void
  readonly onHeal: () => void
  readonly onDemo: () => void
}

export function Controls({
  values,
  feedKind,
  scrub,
  onChange,
  onStep,
  onSubmit,
  onScrub,
  onToggleFeed,
  partitionMode,
  partitioned,
  demoRunning,
  onPartitionMode,
  onHeal,
  onDemo,
}: Props) {
  // Keyed on the committed seed, so React remounts the input (resetting it to
  // the real value) whenever the run changes. No mirrored state to sync.
  const commitSeed = (raw: string, input: HTMLInputElement) => {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed !== values.seed) onChange({ seed: parsed })
    else input.value = String(values.seed)
  }

  return (
    <footer className="foot">
      <button onClick={() => onChange({ playing: !values.playing })}>
        {values.playing ? 'Pause' : 'Play'}
      </button>

      <button onClick={onStep} disabled={values.playing} title="Advance exactly one tick">
        Step
      </button>

      <button onClick={onSubmit} disabled={feedKind === 'mock'} title="Submit a command to the leader">
        Command
      </button>

      <button
        className={partitionMode ? 'armed' : partitioned ? 'hot' : ''}
        disabled={feedKind === 'mock'}
        onClick={onPartitionMode}
        title="Click nodes, or drag across the field, to split the cluster"
      >
        {partitionMode ? 'Cutting…' : 'Partition'}
      </button>

      <button onClick={onHeal} disabled={feedKind === 'mock' || !partitioned}>
        Heal
      </button>

      <button
        className={demoRunning ? 'armed' : ''}
        disabled={feedKind === 'mock'}
        onClick={onDemo}
        title="Split 3/2 with the leader stranded, write to both sides, then heal"
      >
        {demoRunning ? 'Demo…' : 'Demo'}
      </button>

      <button
        className={values.load ? '' : 'hot'}
        disabled={feedKind === 'mock'}
        onClick={() => onChange({ load: !values.load })}
        title="Background client traffic"
      >
        Load {values.load ? 'on' : 'off'}
      </button>

      <div className="sl">
        <label htmlFor="speed">Speed</label>
        <input
          id="speed"
          type="range"
          min="0.2"
          max="2.5"
          step="0.1"
          value={values.speed}
          onChange={(e) => onChange({ speed: Number(e.target.value) })}
        />
        <output>{values.speed.toFixed(1)}×</output>
      </div>

      <div className="sl">
        <label htmlFor="latency">Latency</label>
        <input
          id="latency"
          type="range"
          min="1"
          max="12"
          step="1"
          value={values.latency}
          onChange={(e) => onChange({ latency: Number(e.target.value) })}
        />
        <output>{values.latency}</output>
      </div>

      <div className="sl">
        <label htmlFor="drop">Drop</label>
        <input
          id="drop"
          type="range"
          min="0"
          max="40"
          step="5"
          value={values.dropPercent}
          onChange={(e) => onChange({ dropPercent: Number(e.target.value) })}
        />
        <output>{values.dropPercent}%</output>
      </div>

      {scrub && onScrub && (
        <div className="sl">
          <label htmlFor="scrub">Scrub</label>
          <input
            id="scrub"
            type="range"
            min="0"
            max={scrub.cycle}
            step="1"
            value={Math.floor(scrub.time % scrub.cycle)}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <output>{String(Math.floor(scrub.time % scrub.cycle)).padStart(3, '0')}</output>
        </div>
      )}

      <div className="spacer sl">
        <label htmlFor="seed">Seed</label>
        <input
          id="seed"
          key={values.seed}
          type="text"
          inputMode="numeric"
          defaultValue={values.seed}
          disabled={feedKind === 'mock'}
          onBlur={(e) => commitSeed(e.currentTarget.value, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitSeed(e.currentTarget.value, e.currentTarget)
          }}
        />
      </div>

      <button onClick={onToggleFeed} title="Switch between the real simulation and the scripted mock">
        {feedKind === 'sim' ? 'Sim' : 'Mock'}
      </button>
    </footer>
  )
}
