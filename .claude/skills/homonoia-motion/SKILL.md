---
name: homonoia-motion
description: The visual and motion language for Homonoia's UI. Use whenever writing or reviewing anything in src/ui/ — components, canvas or WebGL rendering, CSS, animation, transitions, color, typography, or layout. Also use when choosing an easing curve or duration, or when a design decision needs to be made and the brief does not specify. The reference implementation is design/reference.html; match it rather than inventing a new direction.
---

# Homonoia — visual language

The reference implementation is `design/reference.html`. Open it before designing
anything. It is scripted, not real Raft, but every color, duration, and state
mapping in it is settled and binding.

The subject is an instrument for observing agreement. Not a dashboard, not a toy.
The nearest relatives are an oscilloscope, a seismograph, an observatory console.

## The two motion languages

This is the rule that governs everything else. Homonoia has two motion registers
and they must not bleed into each other.

**Instrument layer** — the running simulation. Node states, message flight, log
cells, counters, controls. These change constantly and carry information the user
must read precisely.

- Duration 120–200ms. Never longer.
- Easing `cubic-bezier(.2,.8,.2,1)` — fast out, settled, no bounce.
- No stagger except where stagger encodes something real.
- Nothing here should feel cinematic. A message that takes 800ms to cross the
  screen is a bug, not a flourish.

**Cinematic layer** — reserved for exactly four moments:
leader elected, commit index advances, partition opens, partition heals.

- Duration 400–1500ms.
- Easing may overshoot: `cubic-bezier(.35,1.4,.5,1)`.
- These are the only places glow, bloom, ripple, or camera movement are allowed.

If a moment is not on that list of four, it is instrument layer. When unsure,
it is instrument layer.

### Cadence overrides category

**An effect that can fire more than once every few seconds in normal operation is
instrument layer, whichever of the four it marks.** The list is a list of *events*.
An event that recurs on a duty cycle is not an event, it is a state, and dressing
a state as an event drowns whatever it was meant to announce.

So before giving anything cinematic treatment, ask how often it fires in the
system's **busiest ordinary state** — not in the demo, not at rest. If the answer
is "continuously", it is instrument layer no matter what it signifies.

Commit advance is the case that bites, and it bit. Under a steady client load a
cluster commits about once a second, so the field's commit ring — 132px, cinematic
ease, 1.3s — was drawn *more often than the heartbeat* and at 2.6× its radius. It
had become the largest and most constant thing on screen, competing with the
commit crystallization in the ledger that it existed to point at.

The resolution is the general one: **when a cinematic moment turns out to be
frequent, keep the cinematic treatment in exactly one place and demote the rest to
instrument layer.** The ledger's crystallize wave keeps the weight; the field ring
dropped to 66px, alpha .3, linear, 0.6s — enough to acknowledge a commit, not
enough to compete. Two effects announcing the same moment is one too many even
when the moment deserves announcing.

Leader elected stays fully cinematic at 143px: it happens a handful of times in a
run, so it reads as an event and should feel like one. That is the test — not
which of the four it is, but how often it fires.

## Palette

Deep ink, never pure black. Committed state is bone white — ink on paper.

```
--void      #090B12   page
--field     #0C0F17   node field background
--panel     #10131C   side panels
--rule      #1B2030   hairlines
--rule-hi   #2A3146   emphasized hairlines
--ink       #E8E3D6   primary text AND committed entries
--dim       #8E95A6   secondary text
--mute      #555D71   labels, metadata
--leader    #E5A23C   leader state, AppendEntries traffic
--cand      #9B8CF0   candidate state, RequestVote traffic, uncommitted entries
--follow    #586279   follower state
--oxide     #C25438   partition, divergent entries, dropped messages
```

Color encodes node state and message type. It never decorates. Do not introduce a
sixth accent. Do not use green for success — committed uses bone white, because
permanence is the semantic, not approval.

## Typography

- **Instrument Serif** — the wordmark only. Nowhere else.
- **IBM Plex Sans** — UI chrome, labels, buttons.
- **IBM Plex Mono** — all data. Terms, indices, log entries, tick counts, event
  stream, node letters. Set `font-variant-numeric: tabular-nums` everywhere a
  number can change, so digits do not jitter.

Labels are 9.5–10.5px, uppercase, letter-spacing .13–.18em, in `--mute`.
Body 13px. Weights 400 and 500 only.

## The signature: commit crystallization

The single element the project is remembered by. Do not dilute it, do not add a
competing effect elsewhere.

A log entry has four visual states:

| State | Rendering |
|---|---|
| uncommitted | translucent, violet outline, `breathe` animation 2.1s — visibly provisional |
| committed | solid bone fill, dark text, no border — settled, opaque, permanent |
| divergent | oxide outline, about to be truncated |
| truncated | `shatter` — scale down, blur, fade, 400ms |

The transition uncommitted → committed is 550ms on the overshoot curve, staggered
70ms per node so it reads as a wave sweeping down the cluster. This is the moment
the algorithm's central guarantee becomes visible. Everything else in the UI stays
quiet so this can land.

## Node field

- Nodes on a ring, canvas or WebGL, never a flex row of cards.
- Messages travel quadratic bezier arcs pulled 22% toward center. Straight lines
  read as wires; arcs read as transit.
- Message trails: 7 samples behind the head, additive blending, opacity falling
  off. This is what makes them emit light rather than slide.
- Dropped messages disintegrate at the drop point into oxide particles. They never
  simply vanish.
- Leader emits a slow ring pulse on each heartbeat. Followers do not.
- Partition renders as an animated dashed rift on the perpendicular bisector
  between the two group centroids, with a soft oxide gradient wash. Compute it
  from the groups — never hardcode a line.

## Discipline

- No gradients on text. No drop shadows. No border-radius above 2px on data cells.
- Hairlines are 0.5–1px. Thin reads as precise.
- Respect `prefers-reduced-motion`: collapse all durations to near zero, keep
  every state distinguishable by color and fill alone. The UI must remain fully
  readable with motion off — if a state is only legible while animating, that
  state is under-designed.
- Keyboard focus is always visible: 2px `--leader` outline, 2px offset.
- The event stream is monospace, left-aligned, newest at the bottom, capped at
  ~26 lines. It scrolls; it does not animate items other than a 300ms slide-in.

## Performance budget

- 60fps with 5 nodes and up to 40 messages in flight.
- Canvas: single `clearRect`, one composite-mode switch per frame, DPR capped at 2.
- WebGL: the node field only. Panels stay DOM — text must be selectable and
  screen-readable.
- Build the render layer against a mock state feed you can scrub, so it can be
  iterated without the simulation running. Wire it to the real driver last.
