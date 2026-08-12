import type { LogEntry } from './types'

/**
 * Log index arithmetic, in one place.
 *
 * Raft log indices are 1-based (Figure 2: "first index is 1"); the array is
 * 0-based. Every conversion between the two lives in this file. Nothing else in
 * the core may write `log[i - 1]`.
 *
 * Index 0 means "before the first entry" — the empty-log base case for
 * `prevLogIndex` and `commitIndex`.
 */

/** Index of the last entry, or 0 if the log is empty. */
export function lastLogIndex(log: readonly LogEntry[]): number {
  return log.length
}

/** The entry at 1-based `index`, or undefined if out of range (including index 0). */
export function entryAt(log: readonly LogEntry[], index: number): LogEntry | undefined {
  if (index < 1 || index > log.length) return undefined
  return log[index - 1]
}

/**
 * Term of the last entry, or 0 if the log is empty.
 *
 * 0 is a safe sentinel rather than a special case: real entries are created by
 * leaders, leaders exist only in terms >= 1, so 0 is below every real term and
 * an empty log loses every up-to-date comparison it should lose.
 */
export function lastLogTerm(log: readonly LogEntry[]): number {
  return entryAt(log, lastLogIndex(log))?.term ?? 0
}
