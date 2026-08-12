import type { NodeId } from '../raft/types'
import type { Latency } from '../sim/bus'
import { makePrng } from '../sim/prng'
import type { Prng } from '../sim/prng'
import {
  allNodes,
  createSim,
  healCluster,
  isAlive,
  kill,
  leaders,
  partitionCluster,
  revive,
  submit,
  tick,
} from '../sim/sim'
import { formatTrace } from '../sim/trace'
import type { TraceEvent } from '../sim/trace'
import { checkAll, createChecker } from './invariants'
import type { Violation } from './invariants'

/**
 * The fuzz harness.
 *
 * A seed determines everything: the network's latency, drops and duplicates,
 * every election timeout, and the entire failure schedule. Reproducing a
 * failure needs the seed and nothing else — no recorded trace has to be fed
 * back in, because replaying the seed regenerates it.
 *
 * The schedule PRNG is separate from the sim's. They are both derived from the
 * seed, so the run is still fully determined, but keeping the adversary's
 * stream distinct means adding a schedule decision does not shift every
 * latency draw in the network underneath it.
 */

export interface Schedule {
  /** Per-tick probability of a client submitting a command. */
  readonly clientCommand: number
  /** Per-tick probability of killing a live node. */
  readonly kill: number
  /**
   * Fraction of kills that target the current leader rather than a random node.
   * Killing followers barely disturbs the cluster; killing leaders is what
   * forces elections, and elections are what the interesting properties are
   * about.
   */
  readonly killLeaderBias: number
  /** Per-tick probability of reviving a random dead node. */
  readonly revive: number
  /** Per-tick probability of forming a fresh partition. */
  readonly partition: number
  /** Per-tick probability of healing the network. */
  readonly heal: number
  /**
   * Probability that an accepted command is followed, a tick or three later, by
   * the leader crashing.
   *
   * This is the Figure 8 precondition and it is vanishingly rare by accident: a
   * leader replicates to everyone within ~10 ticks, so the window where an
   * entry sits on a minority is tiny, and an untargeted kill almost never lands
   * in it. Without this action the sweep caught a deliberately reintroduced
   * Figure 8 bug in 1 seed out of 1000.
   */
  readonly crashDuringReplication: number
}

/**
 * Tuned against the aggression thresholds below, not guessed. The shape that
 * matters: disruptions must last long enough for an election to complete
 * inside them (a partition healed after 30 ticks against a 150-300 tick
 * election timeout changes nothing), and the cluster must get enough quiet to
 * recover in between, or it never commits anything to endanger.
 */
export const DEFAULT_SCHEDULE: Schedule = {
  clientCommand: 0.05,
  kill: 0.003,
  killLeaderBias: 0.6,
  revive: 0.025,
  partition: 0.0025,
  heal: 0.005,
  crashDuringReplication: 0.04,
}

export interface FuzzOptions {
  readonly seed: number
  readonly ticks?: number
  readonly nodes?: readonly NodeId[]
  readonly latency?: Latency
  readonly electionTimeout?: Latency
  readonly dropProbability?: number
  readonly duplicateProbability?: number
  readonly schedule?: Partial<Schedule>
}

export interface SeedStats {
  readonly ticks: number
  readonly partitionsFormed: number
  readonly heals: number
  readonly kills: number
  readonly leaderKills: number
  readonly crashesDuringReplication: number
  readonly revives: number
  readonly commandsSubmitted: number
  readonly commandsRejected: number
  readonly leaderChanges: number
  readonly maxTerm: number
  readonly entriesCommitted: number
  readonly ticksWithoutLeader: number
  readonly ticksWithMinorityAlive: number
  readonly messagesSent: number
  readonly messagesDropped: number
  readonly messagesPartitioned: number
  readonly messagesDuplicated: number
}

export interface SeedResult {
  readonly seed: number
  readonly ok: boolean
  readonly violation: Violation | null
  readonly stats: SeedStats
  readonly trace: readonly TraceEvent[]
}

const DEFAULT_NODES: NodeId[] = ['n1', 'n2', 'n3', 'n4', 'n5']

/** Fisher-Yates against the seeded PRNG, so the shuffle is part of the replay. */
function shuffled<T>(items: readonly T[], prng: Prng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = prng.nextInt(0, i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function runSeed(options: FuzzOptions): SeedResult {
  const {
    seed,
    ticks = 3000,
    nodes = DEFAULT_NODES,
    // Election timeout is ~3-7x the heartbeat interval, the ratio the paper
    // uses. Tightening it from 150-300 to 50-100 was not cosmetic: at 150-300
    // every leader loss cost ~200 leaderless ticks and the cluster spent 59% of
    // each run with nobody in charge, rejecting more commands than it accepted.
    latency = { min: 1, max: 8 },
    electionTimeout = { min: 50, max: 100 },
    dropProbability = 0.03,
    duplicateProbability = 0.05,
  } = options

  const schedule: Schedule = { ...DEFAULT_SCHEDULE, ...options.schedule }

  const sim = createSim({
    seed,
    nodes,
    latency,
    electionTimeout,
    dropProbability,
    duplicateProbability,
  })

  // Distinct stream for the adversary, still derived from the seed.
  const adversary = makePrng(seed ^ 0x5bf03635)
  const checker = createChecker()

  let partitionsFormed = 0
  let heals = 0
  let kills = 0
  let leaderKills = 0
  let revives = 0
  let commandsSubmitted = 0
  let commandsRejected = 0
  let leaderChanges = 0
  let entriesCommitted = 0
  let ticksWithoutLeader = 0
  let ticksWithMinorityAlive = 0
  let previousLeader: NodeId | null = null
  let crashesDuringReplication = 0
  let pendingCrash: number | null = null
  let command = 0
  let violation: Violation | null = null

  for (let t = 0; t < ticks; t++) {
    // --- The adversary acts, then the clock advances ---

    if (adversary.nextFloat() < schedule.partition) {
      // A real split: at least one node on each side, sizes drawn at random.
      const order = shuffled(nodes, adversary)
      const cut = adversary.nextInt(1, order.length)
      partitionCluster(sim, [order.slice(0, cut), order.slice(cut)])
      partitionsFormed += 1
    }

    if (adversary.nextFloat() < schedule.heal) {
      healCluster(sim)
      heals += 1
    }

    if (adversary.nextFloat() < schedule.kill) {
      const live = nodes.filter((id) => isAlive(sim, id))
      // Leave at least one node running; a cluster of corpses tests nothing.
      if (live.length > 1) {
        const currentLeader = leaders(sim)[0]?.id
        const target =
          adversary.nextFloat() < schedule.killLeaderBias && currentLeader !== undefined
            ? currentLeader
            : live[adversary.nextInt(0, live.length)]

        if (target === currentLeader) leaderKills += 1
        kill(sim, target)
        kills += 1
      }
    }

    if (adversary.nextFloat() < schedule.revive) {
      const dead = nodes.filter((id) => !isAlive(sim, id))
      if (dead.length > 0) {
        revive(sim, dead[adversary.nextInt(0, dead.length)])
        revives += 1
      }
    }

    if (adversary.nextFloat() < schedule.clientCommand) {
      command += 1
      const accepted = submit(sim, { key: `k${command % 12}`, value: `v${command}` })
      if (accepted === null) {
        commandsRejected += 1
      } else {
        commandsSubmitted += 1
        if (adversary.nextFloat() < schedule.crashDuringReplication) {
          // Catch the leader mid-replication, while the new entry is still on a
          // minority.
          pendingCrash = t + 1 + adversary.nextInt(0, 3)
        }
      }
    }

    if (pendingCrash !== null && t >= pendingCrash) {
      pendingCrash = null
      const doomed = leaders(sim)[0]
      if (doomed !== undefined && nodes.filter((id) => isAlive(sim, id)).length > 1) {
        kill(sim, doomed.id)
        kills += 1
        leaderKills += 1
        crashesDuringReplication += 1
      }
    }

    tick(sim)

    // --- Observe ---

    const current = leaders(sim)
    if (current.length === 0) ticksWithoutLeader += 1
    const leaderId = current[0]?.id ?? null
    if (leaderId !== null && leaderId !== previousLeader) leaderChanges += 1
    if (leaderId !== null) previousLeader = leaderId

    const liveCount = nodes.filter((id) => isAlive(sim, id)).length
    if (liveCount * 2 <= nodes.length) ticksWithMinorityAlive += 1

    for (const node of allNodes(sim)) {
      entriesCommitted = Math.max(entriesCommitted, node.commitIndex)
    }

    violation = checkAll(sim, checker)
    if (violation) break
  }

  return {
    seed,
    ok: violation === null,
    violation,
    stats: {
      ticks: sim.now,
      partitionsFormed,
      heals,
      kills,
      leaderKills,
      crashesDuringReplication,
      revives,
      commandsSubmitted,
      commandsRejected,
      leaderChanges,
      maxTerm: Math.max(...allNodes(sim).map((node) => node.currentTerm)),
      entriesCommitted,
      ticksWithoutLeader,
      ticksWithMinorityAlive,
      messagesSent: sim.bus.stats.sent,
      messagesDropped: sim.bus.stats.dropped,
      messagesPartitioned: sim.bus.stats.partitioned,
      messagesDuplicated: sim.bus.stats.duplicated,
    },
    trace: sim.tracer.events,
  }
}

/** Everything you need to reproduce and read a failure. */
export function formatFailure(result: SeedResult): string {
  const { violation } = result
  if (!violation) return `seed ${result.seed}: no violation`

  return [
    '',
    '='.repeat(78),
    `SAFETY VIOLATION — ${violation.property}`,
    '='.repeat(78),
    `seed:     ${result.seed}`,
    `tick:     ${violation.tick}`,
    `property: ${violation.property}`,
    '',
    violation.detail,
    '',
    `reproduce: runSeed({ seed: ${result.seed} })`,
    '',
    '--- trace ---',
    formatTrace(result.trace, { upToTick: violation.tick }),
    '='.repeat(78),
  ].join('\n')
}

export interface SweepReport {
  readonly seeds: number
  readonly failures: readonly SeedResult[]
  readonly totals: SeedStats
  readonly seedsThatCommittedNothing: number
  readonly seedsWithNoLeaderChange: number
}

export function sweep(seeds: readonly number[], options: Omit<FuzzOptions, 'seed'> = {}): SweepReport {
  const failures: SeedResult[] = []
  const totals: Record<string, number> = {}
  let seedsThatCommittedNothing = 0
  let seedsWithNoLeaderChange = 0

  for (const seed of seeds) {
    const result = runSeed({ ...options, seed })

    if (!result.ok) failures.push(result)
    if (result.stats.entriesCommitted === 0) seedsThatCommittedNothing += 1
    if (result.stats.leaderChanges <= 1) seedsWithNoLeaderChange += 1

    for (const [key, value] of Object.entries(result.stats)) {
      totals[key] = (totals[key] ?? 0) + value
    }
  }

  return {
    seeds: seeds.length,
    failures,
    totals: totals as unknown as SeedStats,
    seedsThatCommittedNothing,
    seedsWithNoLeaderChange,
  }
}

/**
 * A readable summary, including an honest verdict on whether the schedule
 * actually stressed the cluster. A green sweep over schedules that never
 * disturbed anything is not evidence of correctness.
 */
export function formatSweep(report: SweepReport): string {
  const { totals, seeds } = report
  const per = (n: number) => (n / seeds).toFixed(1)

  const lines = [
    `seeds:              ${seeds}`,
    `failures:           ${report.failures.length}`,
    '',
    `partitions formed:  ${totals.partitionsFormed} (${per(totals.partitionsFormed)}/seed)`,
    `heals:              ${totals.heals} (${per(totals.heals)}/seed)`,
    `kills:              ${totals.kills} (${per(totals.kills)}/seed)`,
    `  of those, leaders: ${totals.leaderKills} (${per(totals.leaderKills)}/seed)`,
    `  mid-replication:   ${totals.crashesDuringReplication} (${per(totals.crashesDuringReplication)}/seed)`,
    `revives:            ${totals.revives} (${per(totals.revives)}/seed)`,
    `leader changes:     ${totals.leaderChanges} (${per(totals.leaderChanges)}/seed)`,
    `max term reached:   ${totals.maxTerm} total (${per(totals.maxTerm)}/seed)`,
    `entries committed:  ${totals.entriesCommitted} (${per(totals.entriesCommitted)}/seed)`,
    `commands accepted:  ${totals.commandsSubmitted}`,
    `commands rejected:  ${totals.commandsRejected} (no leader at the time)`,
    `ticks with no leader: ${totals.ticksWithoutLeader} (${per(totals.ticksWithoutLeader)}/seed)`,
    `ticks with a minority alive: ${totals.ticksWithMinorityAlive} (${per(totals.ticksWithMinorityAlive)}/seed)`,
    '',
    `messages sent:      ${totals.messagesSent}`,
    `  dropped:          ${totals.messagesDropped}`,
    `  partitioned away: ${totals.messagesPartitioned}`,
    `  duplicated:       ${totals.messagesDuplicated}`,
    '',
    `seeds committing nothing:     ${report.seedsThatCommittedNothing}`,
    `seeds with <=1 leader change: ${report.seedsWithNoLeaderChange}`,
  ]

  const warnings = aggressionWarnings(report)
  if (warnings.length > 0) {
    lines.push('', 'SCHEDULE NOT AGGRESSIVE ENOUGH:', ...warnings.map((w) => `  - ${w}`))
  }

  return lines.join('\n')
}

/**
 * Reasons to distrust a green sweep. Each threshold is a claim that the
 * cluster was actually put under the stress the properties are about.
 */
export function aggressionWarnings(report: SweepReport): string[] {
  const { totals, seeds } = report
  const warnings: string[] = []

  if (totals.partitionsFormed / seeds < 3) {
    warnings.push(`only ${(totals.partitionsFormed / seeds).toFixed(1)} partitions per seed`)
  }
  if (totals.leaderChanges / seeds < 3) {
    warnings.push(`only ${(totals.leaderChanges / seeds).toFixed(1)} leader changes per seed`)
  }
  if (totals.entriesCommitted / seeds < 5) {
    warnings.push(`only ${(totals.entriesCommitted / seeds).toFixed(1)} entries committed per seed`)
  }
  if (report.seedsThatCommittedNothing > seeds * 0.05) {
    warnings.push(`${report.seedsThatCommittedNothing} seeds committed nothing at all`)
  }
  if (totals.kills / seeds < 1) {
    warnings.push(`only ${(totals.kills / seeds).toFixed(1)} kills per seed`)
  }
  if (totals.messagesPartitioned === 0) {
    warnings.push('no message was ever discarded by a partition')
  }
  if (totals.crashesDuringReplication / seeds < 2) {
    warnings.push(
      `only ${(totals.crashesDuringReplication / seeds).toFixed(1)} mid-replication leader crashes per seed — the Figure 8 window is barely being opened`,
    )
  }

  return warnings
}
