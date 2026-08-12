import { describe, expect, it } from 'vitest'

import { formatFailure, formatSweep, runSeed, sweep } from './fuzz'

/**
 * The seeded sweep.
 *
 * `npm test` runs a short one so the suite stays fast; `npm run fuzz` sets
 * FUZZ_SEEDS and runs the real thing.
 */
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 80)
const TICKS = Number(process.env.FUZZ_TICKS ?? 3000)

describe('fuzz sweep', () => {
  it(
    `holds all five safety properties across ${SEEDS} seeds`,
    { timeout: 20 * 60 * 1000 },
    () => {
      const report = sweep(
        Array.from({ length: SEEDS }, (_, i) => i + 1),
        { ticks: TICKS },
      )

      console.log('\n' + formatSweep(report) + '\n')

      for (const failure of report.failures.slice(0, 3)) {
        console.error(formatFailure(failure))
      }

      expect(report.failures.map((f) => `seed ${f.seed}: ${f.violation?.property}`)).toEqual([])
    },
  )
})

describe('the seed is the reproduction', () => {
  it('replays a run exactly, trace included', () => {
    const first = runSeed({ seed: 31337, ticks: 400 })
    const second = runSeed({ seed: 31337, ticks: 400 })

    expect(second.stats).toEqual(first.stats)
    expect(second.trace).toEqual(first.trace)
  })

  it('records every kind of event it claims to', () => {
    const { trace } = runSeed({ seed: 7, ticks: 1500 })
    const kinds = new Set(trace.map((event) => event.kind))

    for (const kind of ['tick', 'send', 'deliver', 'drop', 'duplicate', 'partition', 'kill', 'revive', 'client-command']) {
      expect(kinds, `trace never recorded a ${kind} event`).toContain(kind)
    }
  })

  it('produces different runs for different seeds', () => {
    const a = runSeed({ seed: 1, ticks: 400 })
    const b = runSeed({ seed: 2, ticks: 400 })

    expect(b.trace).not.toEqual(a.trace)
  })
})
