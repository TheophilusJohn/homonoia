import type { Command, Message, NodeId, Rpc } from '../raft/types'

/**
 * A complete, ordered record of everything that happened in a run.
 *
 * The trace is an observation, never an input: nothing in the sim or the core
 * reads it. Because every decision in a run comes from the seeded PRNG in a
 * fixed order, re-running a seed reproduces the trace exactly — the seed is the
 * replay, and the trace is what you read once you have it.
 */

export type DropReason = 'random' | 'partition' | 'node-down'

export type TraceEvent =
  | { readonly tick: number; readonly kind: 'tick' }
  | {
      readonly tick: number
      readonly kind: 'client-command'
      readonly to: NodeId
      readonly command: Command
    }
  | {
      readonly tick: number
      readonly kind: 'send' | 'duplicate'
      readonly seq: number
      readonly message: Message
      readonly deliverAt: number
    }
  | { readonly tick: number; readonly kind: 'deliver'; readonly seq: number; readonly message: Message }
  | {
      readonly tick: number
      readonly kind: 'drop'
      readonly message: Message
      readonly reason: DropReason
      /** Present when the message had already been enqueued (partition, node-down). */
      readonly seq?: number
      readonly sentAt?: number
    }
  | {
      readonly tick: number
      readonly kind: 'partition'
      readonly groups: readonly (readonly NodeId[])[] | null
    }
  | { readonly tick: number; readonly kind: 'kill' | 'revive'; readonly id: NodeId }

export interface Tracer {
  readonly events: TraceEvent[]
  readonly enabled: boolean
}

export function createTracer(enabled = true): Tracer {
  return { events: [], enabled }
}

export function record(tracer: Tracer, event: TraceEvent): void {
  if (!tracer.enabled) return
  tracer.events.push(event)
}

function describeRpc(rpc: Rpc): string {
  switch (rpc.type) {
    case 'request-vote-req':
      return `RequestVote     term=${rpc.term} cand=${rpc.candidateId} lastLog=${rpc.lastLogIndex}/${rpc.lastLogTerm}`
    case 'request-vote-res':
      return `RequestVoteResp term=${rpc.term} granted=${rpc.voteGranted}`
    case 'append-entries-req':
      return `AppendEntries   term=${rpc.term} prev=${rpc.prevLogIndex}/${rpc.prevLogTerm} entries=${rpc.entries.length} leaderCommit=${rpc.leaderCommit}`
    case 'append-entries-res':
      return `AppendEntsResp  term=${rpc.term} success=${rpc.success} match=${rpc.matchIndex}`
  }
}

function describe(event: TraceEvent): string {
  switch (event.kind) {
    case 'tick':
      return 'tick'
    case 'client-command':
      return `client    -> ${event.to}  set ${event.command.key}=${event.command.value}`
    case 'send':
      return `send      ${event.message.from} -> ${event.message.to}  ${describeRpc(event.message.rpc)}  [seq ${event.seq}, due t=${event.deliverAt}]`
    case 'duplicate':
      return `duplicate ${event.message.from} -> ${event.message.to}  ${describeRpc(event.message.rpc)}  [seq ${event.seq}, due t=${event.deliverAt}]`
    case 'deliver':
      return `deliver   ${event.message.from} -> ${event.message.to}  ${describeRpc(event.message.rpc)}  [seq ${event.seq}]`
    case 'drop':
      return `drop      ${event.message.from} -> ${event.message.to}  ${describeRpc(event.message.rpc)}  (${event.reason})`
    case 'partition':
      return event.groups === null
        ? 'heal      network restored'
        : `partition ${event.groups.map((group) => `{${group.join(',')}}`).join(' | ')}`
    case 'kill':
      return `kill      ${event.id}`
    case 'revive':
      return `revive    ${event.id}`
  }
}

export interface FormatOptions {
  /**
   * Include the bare per-tick markers. Off by default: every line already
   * carries its tick, so they are noise in a printed trace even though the
   * recorded trace keeps them.
   */
  readonly includeTicks?: boolean
  /** Only events at or before this tick. */
  readonly upToTick?: number
}

export function formatTrace(events: readonly TraceEvent[], options: FormatOptions = {}): string {
  const { includeTicks = false, upToTick = Infinity } = options

  return events
    .filter((event) => event.tick <= upToTick && (includeTicks || event.kind !== 'tick'))
    .map((event) => `t=${String(event.tick).padStart(5, ' ')}  ${describe(event)}`)
    .join('\n')
}
