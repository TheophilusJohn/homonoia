import type { NodeId } from '../raft/types'
import type { SimFeed } from './simFeed'

/**
 * The scripted demonstration.
 *
 * It shows the one thing a consensus visualization exists to show: a majority
 * makes progress, a minority cannot, and when the network heals the minority's
 * unreplicated work is discarded rather than allowed to corrupt what was
 * agreed.
 *
 * The leader is deliberately placed on the *minority* side. That is what makes
 * the demonstration honest: the old leader does not know it has lost quorum, so
 * it keeps accepting commands and appending them to its log. Those entries can
 * never commit — no majority can acknowledge them — and on heal they are
 * truncated. Put the leader on the majority side instead and the minority has
 * no leader at all, so nothing is submitted and nothing stalls; the interesting
 * failure disappears.
 *
 * Steps are driven off the sim's own tick count, so the script runs at whatever
 * speed the user has set.
 */

export interface DemoStep {
  /** Ticks to wait after the previous step. */
  readonly after: number
  readonly caption: string
  readonly run: (feed: SimFeed, cast: DemoCast) => void
}

export interface DemoCast {
  /** The leader at the moment the demo started — ends up isolated. */
  readonly strandedLeader: NodeId
  readonly minority: readonly NodeId[]
  readonly majority: readonly NodeId[]
}

export function castFor(leader: NodeId, all: readonly NodeId[]): DemoCast {
  // The ally is the leader's neighbour *on the ring*, not just the next id.
  //
  // The rift is the perpendicular bisector between the two group centroids, and
  // no straight line can separate a group whose members sit on opposite sides
  // of the circle. Picking an adjacent node keeps the split contiguous, so the
  // drawn rift actually falls between the two sides instead of cutting through
  // one of them.
  const index = all.indexOf(leader)
  const ally = all[(index + 1) % all.length]

  return {
    strandedLeader: leader,
    // Two of five. Never a quorum.
    minority: [leader, ally],
    majority: all.filter((id) => id !== leader && id !== ally),
  }
}

export const DEMO: readonly DemoStep[] = [
  {
    after: 0,
    caption: 'Network split 3 ⁄ 2 — the leader is on the minority side',
    run: (feed, cast) => feed.partition([cast.majority, cast.minority]),
  },
  {
    after: 120,
    caption: 'Majority elects a new leader in a higher term',
    run: () => {},
  },
  {
    after: 30,
    caption: 'Client writes to the majority side',
    run: (feed, cast) => {
      const leader = feed.leaderId()
      // Only ever the majority's leader — the stranded one is still a leader too.
      if (leader && cast.majority.includes(leader)) {
        feed.submitTo(leader, 'alpha', '1')
      }
    },
  },
  {
    after: 40,
    caption: 'Majority commits — it has a quorum',
    run: (feed, cast) => {
      const leader = feed.leaderId()
      if (leader && cast.majority.includes(leader)) feed.submitTo(leader, 'beta', '2')
    },
  },
  {
    after: 60,
    caption: 'Client writes to the stranded leader — it still believes it leads',
    run: (feed, cast) => {
      feed.submitTo(cast.strandedLeader, 'ghost', 'x')
      feed.submitTo(cast.strandedLeader, 'ghost', 'y')
    },
  },
  {
    after: 90,
    caption: 'Those entries stall — no majority can acknowledge them',
    run: () => {},
  },
  {
    after: 60,
    caption: 'Network heals',
    run: (feed) => feed.heal(),
  },
  {
    after: 140,
    caption: 'Stranded leader steps down, its uncommitted entries truncated',
    run: () => {},
  },
  {
    after: 160,
    caption: 'Cluster in agreement — one log, five copies',
    run: () => {},
  },
]

export const DEMO_LENGTH = DEMO.reduce((sum, step) => sum + step.after, 0)
