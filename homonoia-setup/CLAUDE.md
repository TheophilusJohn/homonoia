# Homonoia

A browser-based implementation and visualization of the Raft consensus algorithm.
Five simulated nodes, a controllable message bus, and a fuzz harness that asserts
Raft's safety properties across thousands of seeded runs.

This is a **correctness-first** project. The visualization exists to demonstrate a
working consensus implementation, not the other way around. Never compromise the
algorithm to make the UI simpler.

---

## The one rule that matters

The Raft core is a **pure function with no I/O**:

```ts
step(state: NodeState, event: Event): { state: NodeState; outbox: Message[] }
```

Inside `src/raft/` the following are **banned**, without exception:

- `setTimeout`, `setInterval`, `requestAnimationFrame`
- `Date.now()`, `performance.now()`, `new Date()`
- `Math.random()` — randomness arrives via a seeded PRNG passed in by the driver
- `fetch`, `WebSocket`, any network call
- any import from `src/ui/`, React, or any browser global

Time enters the core as a `TickEvent`. The core never mutates its input state —
it returns a new object.

Everything else — the browser sim, the test harness — is a **driver** that calls
`step` and routes the outbox. This is what makes the implementation
deterministically testable and replayable. It is the most important design
decision in the project.

A hook enforces this on every write to `src/raft/`. If the hook fires, fix the
code — do not disable the hook, do not add an eslint-disable, do not argue that
this one case is fine.

**If I ask you for something that violates this, push back instead of complying.**

---

## Layout

```
src/raft/      pure core — zero dependencies, no framework imports, runs in bare Node
src/sim/       driver: message bus, virtual clock, partitions, kill/revive
src/test/      fuzz harness, safety assertions, named regression scenarios
src/ui/        React + Vite visualization
design/        reference.html — the visual language. Match it.
```

`src/raft/` must never import from `src/sim/` or `src/ui/`.
Dependency direction is one-way: `ui → sim → raft`.

---

## Build order

Each milestone must be working, tested, and committed before the next begins.
Do not skip ahead. Do not start the visualization early because it is more fun
than log truncation.

1. Types and skeleton — `NodeState`, `Event`, `Message`, `LogEntry`, stubbed `step`.
   Tests for term-handling rules.
2. Leader election — `RequestVote`, randomized seeded timeouts, vote counting.
3. Log replication — `AppendEntries`, consistency check, commit advancement.
4. Simulated network — latency, drops, partitions, kill/revive.
5. Fuzz harness — randomized schedules, all five safety properties checked every
   tick, seed replay on failure. **1000+ seeds green before milestone 6.**
6. Visualization — node field, message animation, log ledger, controls.
7. Partition UI, the demo scenario, deploy, README.

Out of scope, deliberately: log compaction/snapshots, cluster membership changes,
client session handling. Say so in the README.

---

## Working style

- **Explain the Raft rule before writing the code for it.** Name the Figure 2
  clause, state what it guarantees, then implement. I am checking my
  understanding against the paper as we go.
- When a rule is subtle — particularly "commit only entries from the current
  term" and the up-to-date log comparison in `RequestVote` — call it out
  explicitly and explain what breaks without it. Give me the concrete failure
  scenario, not just the rule.
- Do not add features I did not ask for. No extra config, no abstraction layers
  for imagined future needs, no dependencies I didn't approve.
- Prefer many small commits at meaningful boundaries.
- When a fuzz seed fails, print the seed and full event trace first. Do not guess
  at a fix before reading the trace.
- If something is genuinely ambiguous in the paper, say so rather than picking
  silently.

## Testing

- Vitest. `npm test` runs everything; `npm run fuzz` runs the seeded sweep.
- Every safety property is a predicate over the full cluster state, asserted
  after every tick — not spot-checked at the end of a run.
- A regression scenario gets a named test the moment it is found.
