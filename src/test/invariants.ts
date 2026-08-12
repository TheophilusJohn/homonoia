import { expect } from 'vitest'

import type { NodeId } from '../raft/types'
import { allNodes, leaders, liveNodes, tick } from '../sim/sim'
import type { Sim } from '../sim/sim'

/**
 * Safety properties as predicates over the whole cluster, asserted after every
 * tick rather than spot-checked at the end of a run.
 *
 * Three of the five are here. Leader Append-Only and the full run-global form
 * of State Machine Safety need history accumulated across the whole run, which
 * arrives with the fuzz harness in milestone 5.
 */

/**
 * Property 1, Election Safety: at most one leader per term.
 *
 * Live nodes only. A killed node's state is frozen mid-role, so a dead leader
 * still claims the title; it is not running and cannot act on it.
 */
function electionSafety(sim: Sim): void {
  const byTerm = new Map<number, NodeId[]>()

  for (const leader of leaders(sim)) {
    byTerm.set(leader.currentTerm, [...(byTerm.get(leader.currentTerm) ?? []), leader.id])
  }

  for (const [term, ids] of byTerm) {
    expect(ids, `two leaders in term ${term} at tick ${sim.now}`).toHaveLength(1)
  }
}

/**
 * Property 3, Log Matching: if two logs hold an entry with the same index and
 * term, they are identical in every preceding entry.
 *
 * Every node, dead ones included — a log is persistent state and survives a
 * crash, so a dead node's log is just as real as a live one's.
 */
function logMatching(sim: Sim): void {
  const all = allNodes(sim)

  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const shared = Math.min(all[a].log.length, all[b].log.length)

      for (let i = shared - 1; i >= 0; i--) {
        if (all[a].log[i].term !== all[b].log[i].term) continue

        expect(
          all[a].log.slice(0, i + 1),
          `log mismatch below index ${i + 1} between ${all[a].id} and ${all[b].id} at tick ${sim.now}`,
        ).toEqual(all[b].log.slice(0, i + 1))
        break
      }
    }
  }
}

/**
 * Property 5, State Machine Safety, in its within-run form: no two live nodes
 * hold different entries at the same committed index.
 *
 * commitIndex is volatile, so a dead node has nothing meaningful to compare.
 */
function committedPrefixAgreement(sim: Sim): void {
  const live = liveNodes(sim)

  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const upTo = Math.min(live[a].commitIndex, live[b].commitIndex)

      expect(
        live[a].log.slice(0, upTo),
        `committed prefix diverged between ${live[a].id} and ${live[b].id} at tick ${sim.now}`,
      ).toEqual(live[b].log.slice(0, upTo))
    }
  }
}

export function checkInvariants(sim: Sim): void {
  electionSafety(sim)
  logMatching(sim)
  committedPrefixAgreement(sim)
}

/** Advance the sim, checking the safety properties after every tick. */
export function runChecked(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    tick(sim)
    checkInvariants(sim)
  }
}
