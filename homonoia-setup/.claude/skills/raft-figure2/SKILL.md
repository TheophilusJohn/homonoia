---
name: raft-figure2
description: Authoritative reference for the Raft consensus algorithm as specified in Figure 2 of Ongaro & Ousterhout. Use when implementing, reviewing, or debugging any part of leader election, log replication, commit advancement, RequestVote, AppendEntries, term handling, or the five safety properties. Also use when a fuzz seed violates an invariant and the trace needs interpreting. Do not reconstruct Raft rules from memory — read this file.
---

# Raft — Figure 2 and the safety argument

Implement exactly these rules. When code and this file disagree, this file wins.
When this file and the paper disagree, the paper wins — say so rather than guessing.

## State

**Persistent on every server** (survives a crash; on revive these are intact):
- `currentTerm` — latest term seen, initialized to 0, monotonically increasing
- `votedFor` — candidateId that received this node's vote in `currentTerm`, or null
- `log[]` — entries, each `{ term, command }`, first index is 1

**Volatile on every server** (cleared on revive):
- `commitIndex` — highest log index known committed, init 0
- `lastApplied` — highest log index applied to the state machine, init 0

**Volatile on leaders** (reinitialized after every election):
- `nextIndex[]` — for each follower, next log index to send. Init to `leader last log index + 1`
- `matchIndex[]` — for each follower, highest index known replicated. Init to 0

The `nextIndex` optimism / `matchIndex` pessimism split is deliberate. `nextIndex`
is a guess that gets walked back on rejection; `matchIndex` is only ever advanced
on a confirmed success. Never use `nextIndex` for the commit calculation.

## Rules for all servers

- If `commitIndex > lastApplied`: increment `lastApplied`, apply `log[lastApplied]`
  to the state machine.
- **If any RPC request or response contains term T > `currentTerm`: set
  `currentTerm = T`, set `votedFor = null`, convert to Follower.** This applies to
  responses too, not just requests. It applies before any other handling of the
  message. A leader that sees a higher term steps down immediately.
- If an RPC has term < `currentTerm`, reject it and reply with `currentTerm`.

## RequestVote RPC

Arguments: `term`, `candidateId`, `lastLogIndex`, `lastLogTerm`.
Results: `term`, `voteGranted`.

Receiver:
1. Reply false if `term < currentTerm`.
2. If `votedFor` is null or equals `candidateId`, **and** the candidate's log is at
   least as up-to-date as the receiver's, grant the vote.

### The up-to-date comparison — get this exactly right

The candidate's log is at least as up-to-date if:

```
lastLogTerm > myLastLogTerm
  OR (lastLogTerm === myLastLogTerm AND lastLogIndex >= myLastLogIndex)
```

**Term is compared first, and it dominates.** A longer log does not win. A log with
a higher final term wins even if it is shorter.

*What breaks without it:* a node that was partitioned away and accumulated many
uncommitted entries at a stale term has the longest log in the cluster. If length
were the criterion it would win the election and then force its stale suffix onto
nodes that already committed different entries at those indices — destroying
Leader Completeness and State Machine Safety. Comparing term first is what
guarantees the winner's log contains every committed entry.

## AppendEntries RPC

Arguments: `term`, `leaderId`, `prevLogIndex`, `prevLogTerm`, `entries[]`, `leaderCommit`.
Results: `term`, `success`.

Receiver:
1. Reply false if `term < currentTerm`.
2. Reply false if the log does not contain an entry at `prevLogIndex` whose term
   matches `prevLogTerm`.
3. If an existing entry conflicts with a new one (same index, different term),
   delete that entry **and every entry that follows it**.
4. Append any new entries not already in the log.
5. If `leaderCommit > commitIndex`: set
   `commitIndex = min(leaderCommit, index of last new entry)`.

Step 3's truncation must not be applied blindly. If the follower's log already
matches, do not truncate — a delayed duplicate AppendEntries would otherwise
delete entries the leader still considers replicated. Only truncate on an actual
term conflict at that index.

Empty `entries[]` is the heartbeat. It still runs the full consistency check.

## Leaders

- On election: send initial empty AppendEntries to every follower, then repeat
  during idle periods to prevent election timeouts.
- On client command: append to local log, then replicate. Apply only after commit.
- If `last log index >= nextIndex[f]`: send AppendEntries starting at `nextIndex[f]`.
  - On success: update `nextIndex[f]` and `matchIndex[f]`.
  - On failure due to log inconsistency: decrement `nextIndex[f]` and retry.
    (Distinguish this from failure due to a higher term — that one means step down.)

### Commit advancement — the current-term restriction

```
If there exists N > commitIndex such that
    a majority of matchIndex[i] >= N
    AND log[N].term === currentTerm
then commitIndex = N
```

**The `log[N].term === currentTerm` clause is not optional.**

*What breaks without it:* the Figure 8 scenario. A leader in term 2 partially
replicates an entry at index 3 to a minority, then crashes. A new leader in term 3
sees that entry on a majority and — without the restriction — marks it committed.
It then crashes before replicating anything of its own. A third leader, elected in
term 4 with a log that legitimately lacks index 3, overwrites it. An entry that was
reported committed has been erased. Client saw an acknowledged write disappear.

A leader commits entries from previous terms only *indirectly*: by committing one
of its own current-term entries, which by Log Matching drags every preceding entry
along with it. This is why a new leader should append a no-op entry on election if
you want prompt commitment of inherited entries — but that is an optimization,
not required, and out of scope unless asked.

## Election

- Followers that receive no communication before their election timeout become
  Candidates.
- On becoming Candidate: increment `currentTerm`, vote for self, reset the election
  timer, send RequestVote to all others.
- Win on votes from a majority — including its own. Become Leader.
- If AppendEntries arrives from a legitimate leader (term >= own), become Follower.
- On split vote, the timeout elapses and a new election begins at a higher term.
- Election timeouts are randomized, drawn from the **seeded PRNG supplied by the
  driver**. Never `Math.random()`. Typical range: 150–300 in tick units, with the
  heartbeat interval well below the minimum.

## The five safety properties

Each is a predicate over the entire cluster state, asserted after every tick.

1. **Election Safety** — at most one leader per term.
   `∀ term t: |{ n : n.state === Leader ∧ n.currentTerm === t }| ≤ 1`

2. **Leader Append-Only** — a leader never overwrites or deletes entries in its own
   log. Check by snapshotting each leader's log and confirming the previous
   snapshot is a prefix of the current one.

3. **Log Matching** — if two logs contain an entry with the same index and term,
   the logs are identical in all preceding entries.
   `∀ a,b ∀ i: a.log[i].term === b.log[i].term ⇒ a.log[0..i] === b.log[0..i]`

4. **Leader Completeness** — an entry committed in a given term is present in the
   log of every leader of every higher term. Track the set of committed
   `(index, term, command)` triples across the whole run and check each new leader
   against it.

5. **State Machine Safety** — no two nodes apply different commands at the same log
   index. Track applied commands per index globally; a mismatch is a violation.

Property 4 needs run-global history, not just current state. Build a shadow
`committedHistory` in the harness — the algorithm must not read it.

## Reading a failing trace

1. Find the tick where the property first flipped false, not where it was noticed.
2. Identify the term boundary immediately before it.
3. Check in order: did a node fail to step down on a higher term; did a vote get
   granted against the up-to-date rule; did commit advance without the current-term
   clause; did a truncation delete a committed entry.
4. Reproduce with the seed before changing any code.
