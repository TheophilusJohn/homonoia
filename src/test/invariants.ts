import { entryAt } from '../raft/log'
import type { LogEntry, NodeId } from '../raft/types'
import { allNodes, leaders, liveNodes, tick } from '../sim/sim'
import type { Sim } from '../sim/sim'

/**
 * Raft's five safety properties, as predicates over the whole cluster, checked
 * after every tick.
 *
 * Three are stateless — they read the current cluster and nothing else. Two
 * need history accumulated across the whole run:
 *
 *   - Leader Append-Only compares each leader's log against its own log one
 *     tick earlier.
 *   - State Machine Safety needs to know what was *ever* committed at an index,
 *     because the violation is an index changing value long after the fact.
 *
 * The shadow history lives here, in the checker. The algorithm cannot read it
 * and does not know it exists — if the implementation needed it, it would not
 * be an implementation of Raft.
 */

export interface Violation {
  readonly property: string
  readonly tick: number
  readonly detail: string
}

interface CommittedRecord {
  readonly entry: LogEntry
  /** Term of the node that first reported this index committed. */
  readonly inTerm: number
}

export interface Checker {
  /** Shadow history: log index -> the entry that was committed there. Append-only. */
  readonly committed: Map<number, CommittedRecord>
  /** Log snapshot per `${id}@${term}`. Keyed by term because a node is only continuously leader within one. */
  readonly leaderLogs: Map<string, readonly LogEntry[]>
  /** Cheap change detection per node, so committed prefixes are not rescanned every tick. */
  readonly seen: Map<NodeId, { logRef: readonly LogEntry[]; verifiedTo: number }>
}

export function createChecker(): Checker {
  return { committed: new Map(), leaderLogs: new Map(), seen: new Map() }
}

function sameEntry(a: LogEntry, b: LogEntry): boolean {
  return a.term === b.term && a.command.key === b.command.key && a.command.value === b.command.value
}

function isPrefix(prefix: readonly LogEntry[], log: readonly LogEntry[]): boolean {
  if (prefix.length > log.length) return false
  return prefix.every((entry, i) => sameEntry(entry, log[i]))
}

function describe(log: readonly LogEntry[]): string {
  return `[${log.map((e, i) => `${i + 1}:t${e.term}:${e.command.key}=${e.command.value}`).join(' ')}]`
}

/**
 * Property 1, Election Safety: at most one leader per term.
 *
 * Live nodes only. A killed node's state is frozen mid-role, so a dead leader
 * still claims the title; it is not running and cannot act on it.
 */
function electionSafety(sim: Sim): Violation | null {
  const byTerm = new Map<number, NodeId[]>()

  for (const leader of leaders(sim)) {
    byTerm.set(leader.currentTerm, [...(byTerm.get(leader.currentTerm) ?? []), leader.id])
  }

  for (const [term, ids] of byTerm) {
    if (ids.length > 1) {
      return {
        property: 'Election Safety',
        tick: sim.now,
        detail: `${ids.length} leaders in term ${term}: ${ids.join(', ')}`,
      }
    }
  }
  return null
}

/**
 * Property 2, Leader Append-Only: a leader never overwrites or deletes entries
 * in its own log.
 *
 * Keyed by id *and* term. A node that steps down, has its log truncated as a
 * follower, and is later elected again is not the same leader — its earlier
 * snapshot says nothing about the new one. Within a single term a leader never
 * steps down and back up, so id+term is exactly "continuously leader".
 */
function leaderAppendOnly(sim: Sim, checker: Checker): Violation | null {
  for (const leader of leaders(sim)) {
    const key = `${leader.id}@${leader.currentTerm}`
    const previous = checker.leaderLogs.get(key)

    if (previous !== undefined && !isPrefix(previous, leader.log)) {
      return {
        property: 'Leader Append-Only',
        tick: sim.now,
        detail: `${leader.id} in term ${leader.currentTerm} no longer extends its own log\n  was: ${describe(previous)}\n  now: ${describe(leader.log)}`,
      }
    }

    checker.leaderLogs.set(key, leader.log)
  }
  return null
}

/**
 * Property 3, Log Matching: if two logs hold an entry with the same index and
 * term, they are identical in every preceding entry.
 *
 * Every node, dead ones included — a log is persistent state and survives a
 * crash. Checking the highest shared index whose terms agree is sufficient: if
 * the prefixes match there, they match at every lower index too.
 */
function logMatching(sim: Sim): Violation | null {
  const all = allNodes(sim)

  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const shared = Math.min(all[a].log.length, all[b].log.length)

      for (let i = shared - 1; i >= 0; i--) {
        if (all[a].log[i].term !== all[b].log[i].term) continue

        if (!isPrefix(all[a].log.slice(0, i + 1), all[b].log.slice(0, i + 1))) {
          return {
            property: 'Log Matching',
            tick: sim.now,
            detail: `${all[a].id} and ${all[b].id} agree on index ${i + 1} term ${all[a].log[i].term} but differ below it\n  ${all[a].id}: ${describe(all[a].log.slice(0, i + 1))}\n  ${all[b].id}: ${describe(all[b].log.slice(0, i + 1))}`,
          }
        }
        break
      }
    }
  }
  return null
}

/**
 * Property 5, State Machine Safety: no two nodes ever hold different entries at
 * the same committed index.
 *
 * This is where the shadow history earns its place — the violation is an index
 * that was committed as one command and later reads as another, which no
 * snapshot of the present can see.
 *
 * The rescan is skipped when a node's log is the same array it was last tick.
 * The core is pure and only builds a new log array when the log actually
 * changes, so reference equality is a sound "nothing was truncated" test.
 */
function stateMachineSafety(sim: Sim, checker: Checker): Violation | null {
  for (const node of liveNodes(sim)) {
    const previous = checker.seen.get(node.id)
    const logChanged = previous === undefined || previous.logRef !== node.log
    const from = logChanged ? 1 : previous.verifiedTo + 1

    for (let index = from; index <= node.commitIndex; index++) {
      const entry = entryAt(node.log, index)

      if (entry === undefined) {
        return {
          property: 'State Machine Safety',
          tick: sim.now,
          detail: `${node.id} has commitIndex ${node.commitIndex} but only ${node.log.length} entries`,
        }
      }

      const known = checker.committed.get(index)
      if (known === undefined) {
        checker.committed.set(index, { entry, inTerm: node.currentTerm })
      } else if (!sameEntry(known.entry, entry)) {
        return {
          property: 'State Machine Safety',
          tick: sim.now,
          detail:
            `index ${index} was committed as t${known.entry.term}:${known.entry.command.key}=${known.entry.command.value} ` +
            `but ${node.id} now has it committed as t${entry.term}:${entry.command.key}=${entry.command.value}`,
        }
      }
    }

    checker.seen.set(node.id, { logRef: node.log, verifiedTo: node.commitIndex })
  }
  return null
}

/**
 * Property 4, Leader Completeness: an entry committed in a given term is
 * present in the log of every leader of every higher term.
 *
 * Checked against the shadow history rather than the present, for the same
 * reason as property 5: the entry may have been committed thousands of ticks
 * and several leaders ago.
 */
function leaderCompleteness(sim: Sim, checker: Checker): Violation | null {
  for (const leader of leaders(sim)) {
    for (const [index, record] of checker.committed) {
      if (record.inTerm >= leader.currentTerm) continue

      const held = entryAt(leader.log, index)
      if (held === undefined || !sameEntry(held, record.entry)) {
        return {
          property: 'Leader Completeness',
          tick: sim.now,
          detail:
            `${leader.id} is leader in term ${leader.currentTerm} but is missing index ${index}, ` +
            `committed in term ${record.inTerm} as t${record.entry.term}:${record.entry.command.key}=${record.entry.command.value}` +
            (held ? ` (holds t${held.term}:${held.command.key}=${held.command.value} instead)` : ' (log too short)'),
        }
      }
    }
  }
  return null
}

/** All five, in order. Returns the first violation found, or null. */
export function checkAll(sim: Sim, checker: Checker): Violation | null {
  return (
    electionSafety(sim) ??
    leaderAppendOnly(sim, checker) ??
    logMatching(sim) ??
    stateMachineSafety(sim, checker) ??
    leaderCompleteness(sim, checker)
  )
}

/**
 * One checker per sim, so the run-global history survives across separate
 * `runChecked` calls. A test that ticks in a loop would otherwise reset the
 * shadow history on every call and never see a late violation.
 */
const checkers = new WeakMap<Sim, Checker>()

function checkerFor(sim: Sim): Checker {
  const existing = checkers.get(sim)
  if (existing) return existing

  const fresh = createChecker()
  checkers.set(sim, fresh)
  return fresh
}

/**
 * Advance the sim, checking all five properties after every tick. Throws on the
 * tick a property first goes false.
 */
export function runChecked(sim: Sim, ticks: number, checker: Checker = checkerFor(sim)): void {
  for (let i = 0; i < ticks; i++) {
    tick(sim)
    const violation = checkAll(sim, checker)
    if (violation) {
      throw new Error(
        `${violation.property} violated at tick ${violation.tick} (seed ${sim.seed})\n${violation.detail}`,
      )
    }
  }
}
