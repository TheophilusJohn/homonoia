# Homonoia

A browser-based implementation of the [Raft consensus algorithm](https://raft.github.io/raft.pdf),
with a simulated network you can break and a fuzz harness that asserts Raft's five
safety properties across thousands of seeded runs.

Five nodes on a ring. Cut the network, kill the leader, watch a minority stall and
then converge. The visualization exists to demonstrate a working consensus
implementation — not the other way around.

---

## What Raft is

A cluster of servers has to agree on an ordered log of commands, and keep agreeing
while machines crash and the network drops, delays, duplicates and reorders
messages. Raft solves this by electing a **leader** for a numbered **term**. The
leader is the only node that accepts client writes; it appends them to its log and
replicates them outward. An entry is **committed** once a majority of the cluster
has stored it, and only then is it applied to the state machine — here, a
key-value store.

Two rules do most of the work, and both are easy to get subtly wrong:

- **The up-to-date check.** A node grants its vote only if the candidate's log is
  at least as up-to-date as its own — comparing the *last term first*, and only
  falling back to length when the terms are equal. A longer log does not win. This
  is what guarantees any node that can win an election already holds every
  committed entry.
- **The current-term commit restriction.** A leader may only commit an entry from
  *its own* term. Entries inherited from earlier terms commit indirectly, when a
  current-term entry above them commits. Skipping this is the Figure 8 scenario:
  an entry reaches a majority, is reported committed, and is later overwritten by
  a leader that legitimately never had it. A client sees an acknowledged write
  vanish.

Both are explained at the point of implementation in
[`src/raft/step.ts`](src/raft/step.ts), and both have tests that fail if the rule
is removed — see [Verification](#verification).

---

## Architecture: the core is a pure function

The entire algorithm is one function with no I/O:

```ts
step(state: NodeState, event: Event): { state: NodeState; outbox: Message[] }
```

Inside `src/raft/` these are banned outright: `setTimeout`, `Date.now()`,
`Math.random()`, `fetch`, any browser global, and any import from `src/sim/` or
`src/ui/`. Time enters as a `TickEvent`. Randomness — the election timeout —
arrives as a number on that event, drawn by the driver from a seeded PRNG. The
core never mutates its input; it returns a new state.

Everything else is a **driver** that calls `step` and routes the outbox.

```
src/raft/   pure core — zero dependencies, runs in bare Node
src/sim/    driver: seeded PRNG, message bus, virtual clock, partitions, kill/revive
src/test/   fuzz harness, safety invariants, named regression scenarios
src/ui/     React + Vite visualization
design/     reference.html — the visual language
```

Dependencies point one way: `ui → sim → raft`. A git hook enforces the ban on
every write to `src/raft/`.

**Why this matters.** Because `step` is pure and every random draw comes from one
seeded generator in a fixed order, a seed reproduces a run *exactly* — the same
message interleaving, the same elections, the same failures. When the fuzzer finds
a violation it prints the seed, and that seed alone regenerates the whole trace.
Nothing has to be recorded and replayed. The same property lets the UI scrub
backwards: seeking to an earlier tick rebuilds the sim from its seed and replays.

The visualization is a projection of this, not a reimplementation. `src/ui/`
consumes a `ViewState` snapshot; both the real simulation and a scripted mock feed
satisfy the same interface.

---

## The simulated network

`src/sim/bus.ts` holds every message in flight until its delivery tick.

- **Latency** is sampled per message, independently. Reordering is not a separate
  shuffle — it falls out of two messages sent on the same tick drawing different
  latencies. Measured at 152 of 456 deliveries out of send order in an ordinary run.
- **Drops** at a configurable rate.
- **Duplicates** at a configurable rate; the copy draws its own latency, so it
  interleaves with live traffic instead of arriving back to back.
- **Partitions** are groups of node IDs. A message crossing a group boundary is
  discarded at delivery, so a message already on the wire when a split forms is
  lost, and one still in flight when it heals gets through.
- **Kill** freezes a node: no events in, no output, timers stopped. **Revive**
  keeps `currentTerm`, `votedFor` and the log — the state Figure 2 requires on
  stable storage — and rebuilds everything volatile, so the node reapplies its log
  as a leader tells it what is committed.

---

## Verification

### The five safety properties

Checked after **every tick**, not spot-checked at the end
([`src/test/invariants.ts`](src/test/invariants.ts)):

| # | Property | How it is checked |
|---|---|---|
| 1 | **Election Safety** — at most one leader per term | Group live leaders by term |
| 2 | **Leader Append-Only** — a leader never overwrites its own log | Snapshot per `(id, term)`; the previous must be a prefix of the current |
| 3 | **Log Matching** — same index + same term ⟹ identical prefixes | Pairwise, at the highest shared index whose terms agree |
| 4 | **Leader Completeness** — a committed entry is in every later leader's log | Shadow `committedHistory` vs each live leader |
| 5 | **State Machine Safety** — no two nodes apply different commands at an index | Shadow `committedHistory`, which catches an index changing value long after the fact |

Properties 2, 4 and 5 need history the current cluster state cannot show. That
history lives in the checker, and **the algorithm cannot read it** — if the
implementation needed it, it would not be Raft.

### The fuzz sweep

```bash
npm run fuzz     # 1000 seeds × 3000 ticks
```

Each seed generates a randomized failure schedule — partitions forming and
healing, kills, revives, drops, duplicates, client commands — from a PRNG derived
from the seed. On violation it prints the property, the tick, the seed, and the
full trace up to that point.

Latest sweep, **1000 seeds × 3000 ticks, 0 failures**, ~10s:

| | total | per seed |
|---|---|---|
| partitions formed | 7,515 | 7.5 |
| kills | 12,792 | 12.8 |
| — of those, leaders | 7,591 | 7.6 |
| revives | 12,608 | 12.6 |
| leader changes | 8,422 | 8.4 |
| entries committed | 89,253 | 89.3 |
| max term reached | 21,370 | 21.4 |
| messages sent | 1,993,145 | — |
| — dropped | 59,961 | — |
| — discarded by partition | 189,954 | — |
| — duplicated | 96,741 | — |

Zero seeds committed nothing; zero seeds had ≤1 leader change.

The harness prints a `SCHEDULE NOT AGGRESSIVE ENOUGH` warning against six
thresholds when a sweep stops stressing the cluster, so a green run cannot quietly
become a vacuous one. It fired during development: an early schedule produced 1.7
leader changes per seed, because kills hit random nodes (mostly followers) and a
150–300 tick election timeout meant every leader loss cost ~200 idle ticks. Fixed
by biasing kills at the leader and tightening the timeout to 50–100 ticks — 3–7×
the heartbeat interval, the ratio the paper uses.

### Tests that fail when the rule is removed

A test for a safety rule is worth nothing if it passes with the rule deleted. Each
of these was verified by reintroducing the bug:

| Rule removed | What fails |
|---|---|
| Current-term commit restriction | 2 unit tests + the scripted Figure 8 scenario, deterministically at tick 1529 |
| Truncate only on a genuine term conflict | The delayed-duplicate test, on the committed-prefix invariant at tick 633 |
| Up-to-date check comparing index before term | 8 of 200 fuzz seeds, as Leader Completeness |

**The Figure 8 finding.** With the current-term restriction deleted, the random
fuzz sweep caught it in roughly **1 seed in 1000** — a lottery, not a guard. It
needs four things to coincide: an entry stranded on a minority, a competing
higher-term entry at the same index, the node holding that entry unreachable while
the old one reaches a majority, and reachable again afterwards. An untargeted
adversary almost never arranges all four, and turning up the chaos made detection
*worse*, because the cluster committed less. Adding a mid-replication leader crash
raised leader churn but did not improve detection.

So Figure 8 is **scripted end to end** in
[`src/test/scenarios.test.ts`](src/test/scenarios.test.ts) instead, where it fails
deterministically with the bug present. Random fuzzing is good at the broad
classes and bad at this one; saying so is more useful than a green sweep that
implies otherwise.

### Everything else

```bash
npm test         # 128 tests: core units, sim, scenarios, UI, short fuzz sweep
npm run lint
npm run build
```

Named scenarios include: leader killed mid-term with committed entries preserved,
duplicated messages not double-appending or manufacturing a majority, a
long-delayed duplicate not truncating entries a follower has moved past, Figure 8,
and the partition demo below.

---

## The demo

**Partition 3–2 with the leader stranded on the minority side.** Press *Demo* in
the running app, or read it as a test in `src/test/scenarios.test.ts`.

1. The network splits. The leader is on the two-node side.
2. The majority elects a new leader in a higher term.
3. Writes to the majority side **commit** — it has a quorum.
4. The stranded leader has not heard a higher term, so it still believes it leads
   and still accepts writes. Those entries append and **stall uncommitted**
   forever; no majority can acknowledge them.
5. The network heals. The stranded leader sees the higher term, steps down, and
   its unreplicated entries are **truncated**.
6. One log, five copies.

The leader is on the minority side deliberately. Put it on the majority side and
the minority has no leader to write to at all — nothing stalls, and the
interesting failure never happens.

---

## Deliberately out of scope

These are real parts of Raft and are **not** implemented:

- **Log compaction / snapshots.** Logs grow without bound.
- **Cluster membership changes.** The five nodes are fixed; there is no joint
  consensus.
- **Client session handling.** No deduplication of retried commands, no
  linearizable reads, no leader redirection — a command sent to a follower is
  ignored rather than forwarded.
- **Persistence.** "Persistent" state survives a simulated crash, not a page
  reload.
- **Pre-vote.** A node that steps down on a higher-term RequestVote resets its
  election timer even when it denies the vote. This costs liveness, never safety.

---

## Two deviations from Figure 2

Both are documented at the code, not just here.

**1. `AppendEntriesResponse` carries a `matchIndex`.** Figure 2's response is
`{term, success}`, and its leader infers `matchIndex` from the request it sent. A
pure `step` keeps no in-flight RPC table, and once the network reorders and
duplicates, inferring the value from `nextIndex` would advance `matchIndex` to the
wrong place — and `matchIndex` is exactly what the commit calculation reads.
Carrying the index makes the response self-describing. etcd/raft does the same.

**2. The follower's commit clause has a `max` Figure 2 does not mention.** Clause
5 reads `commitIndex = min(leaderCommit, index of last new entry)`. A delayed
message can satisfy `leaderCommit > commitIndex` while its last new entry sits
*below* what has already been committed, so the literal formula moves `commitIndex`
backwards. This is an omission in the figure rather than a disagreement — the
paper's prose is clear that `commitIndex` is monotonic — but it is a real edge
case with a test.

---

## Running it

```bash
npm install
npm run dev      # observatory at localhost:5173
npm test
npm run fuzz
npm run deploy   # build + publish to Cloudflare Pages (needs `wrangler login` once)
```

**Controls.** Play/pause, step one tick, submit a command, speed, latency, drop
rate, seed. Click a node to kill or revive it. *Partition* then click nodes to move
them across the rift, or drag across the field to cut. *Load* toggles background
client traffic.

The rift is the perpendicular bisector between the two group centroids, computed
from the groups — split the cluster any way and the line falls where the split
actually is. Messages crossing it disintegrate on the line, at the point where the
message's bezier arc meets it, solved exactly rather than sampled.

`prefers-reduced-motion` is respected: trails, glow and pulses are dropped, and
every state stays legible by colour and fill alone.

---

## Credit

The algorithm is Diego Ongaro and John Ousterhout's,
*[In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf)*
(USENIX ATC 2014). Any bug here is this implementation's, not the paper's.
