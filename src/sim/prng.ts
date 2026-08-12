/**
 * Seeded pseudo-random number generator for the driver.
 *
 * This lives in the driver, never in `src/raft/`. The core is a pure function;
 * every random value it needs (election timeouts, message drops, latency) is
 * drawn here and handed in on an event. A run is therefore fully determined by
 * its seed, which is what makes a failing fuzz seed replayable.
 *
 * Algorithm is mulberry32: 32-bit state, one multiply-xorshift round per draw.
 * Not cryptographic — it is chosen for being short, fast, and identical across
 * platforms.
 */
export interface Prng {
  /** Next value in [0, 1). */
  nextFloat(): number
  /** Next integer in [min, max). */
  nextInt(min: number, max: number): number
}

export function makePrng(seed: number): Prng {
  let state = seed >>> 0

  const nextFloat = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    nextFloat,
    nextInt: (min, max) => min + Math.floor(nextFloat() * (max - min)),
  }
}
