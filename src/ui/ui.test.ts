import { describe, expect, it } from 'vitest'

import { arcPoint, NODE_RADIUS, ringLayout } from './field/geometry'
import { nodeAtPoint } from './field/render'
import { createMockFeed, MOCK_CYCLE_TICKS } from './mockFeed'
import { createSimFeed } from './simFeed'
import type { ViewState } from './viewModel'

const IDS = ['n1', 'n2', 'n3', 'n4', 'n5']

describe('ring layout', () => {
  it('places every node on a circle about the centre', () => {
    const layout = ringLayout(IDS, 800, 600)
    const radius = Math.min(800, 600) * 0.31

    expect(layout.size).toBe(5)
    for (const point of layout.values()) {
      expect(Math.hypot(point.x - 400, point.y - 300)).toBeCloseTo(radius, 5)
    }
  })

  it('starts at twelve o clock', () => {
    const first = ringLayout(IDS, 800, 600).get('n1')!

    expect(first.x).toBeCloseTo(400, 5)
    expect(first.y).toBeLessThan(300)
  })

  it('spaces nodes evenly', () => {
    const layout = ringLayout(IDS, 800, 800)
    const angles = IDS.map((id) => {
      const p = layout.get(id)!
      return Math.atan2(p.y - 400, p.x - 400)
    })

    for (let i = 1; i < angles.length; i++) {
      const gap = ((angles[i] - angles[i - 1] + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      expect(Math.abs(gap)).toBeCloseTo((2 * Math.PI) / 5, 5)
    }
  })
})

describe('message arcs', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 100, y: 0 }
  const centre = { x: 50, y: 100 }

  it('starts on the sender and ends on the receiver', () => {
    expect(arcPoint(from, to, centre, 0)).toEqual(from)
    expect(arcPoint(from, to, centre, 1)).toEqual(to)
  })

  // Straight lines read as wires; the pull toward centre is what makes a
  // message read as crossing the cluster.
  it('bows toward the centre rather than running straight', () => {
    const mid = arcPoint(from, to, centre, 0.5)

    expect(mid.x).toBeCloseTo(50, 5)
    expect(mid.y).toBeGreaterThan(0)
    expect(mid.y).toBeLessThan(centre.y)
  })
})

describe('hit testing', () => {
  const state: Pick<ViewState, 'nodes'> = {
    nodes: IDS.map((id) => ({
      id,
      role: 'follower' as const,
      term: 1,
      alive: true,
      commitIndex: 0,
      log: [],
    })),
  }

  it('finds the node under the point', () => {
    const first = ringLayout(IDS, 800, 600).get('n1')!

    expect(nodeAtPoint(state, first.x, first.y, 800, 600)).toBe('n1')
    expect(nodeAtPoint(state, first.x + NODE_RADIUS - 2, first.y, 800, 600)).toBe('n1')
  })

  it('returns null for empty space', () => {
    expect(nodeAtPoint(state, 400, 300, 800, 600)).toBeNull()
  })
})

describe('mock feed', () => {
  const feed = createMockFeed()

  // The whole reason the mock exists: the render layer can be scrubbed to any
  // moment without a simulation running, and lands in the same place every time.
  it('is a pure function of time', () => {
    for (const t of [0, 37.5, 120, 260, 339]) {
      expect(feed.seek(t)).toEqual(feed.seek(t))
    }
  })

  it('does not depend on the order it is seeked in', () => {
    const forward = [0, 50, 100, 200].map((t) => feed.seek(t))
    const backward = [200, 100, 50, 0].map((t) => feed.seek(t)).reverse()

    expect(backward).toEqual(forward)
  })

  it('loops, so a scrub anywhere lands somewhere meaningful', () => {
    const a = feed.seek(80)
    const b = feed.seek(80 + MOCK_CYCLE_TICKS)

    expect(b.nodes).toEqual(a.nodes)
  })

  it('reaches every visual state across a cycle', () => {
    const roles = new Set<string>()
    const cells = new Set<string>()
    let sawDrop = false
    let sawVote = false

    for (let t = 0; t < MOCK_CYCLE_TICKS; t += 1) {
      const state = feed.seek(t)
      for (const node of state.nodes) {
        roles.add(node.alive ? node.role : 'dead')
        for (const cell of node.log) cells.add(cell.state)
      }
      if (state.drops.length > 0) sawDrop = true
      if (state.messages.some((m) => m.kind === 'vote')) sawVote = true
    }

    expect(roles).toContain('leader')
    expect(roles).toContain('candidate')
    expect(roles).toContain('dead')
    expect(cells).toContain('committed')
    expect(cells).toContain('uncommitted')
    expect(sawDrop).toBe(true)
    expect(sawVote).toBe(true)
  })
})

describe('sim feed', () => {
  it('elects a leader and commits entries', () => {
    const feed = createSimFeed({ seed: 20260811 })
    const state = feed.seek(400)

    expect(state.nodes.filter((node) => node.role === 'leader')).toHaveLength(1)
    expect(state.commitIndex).toBeGreaterThan(0)
    expect(state.events.length).toBeGreaterThan(0)
  })

  // Seeking backwards rebuilds from the seed, which is exact because the sim is
  // deterministic. Without that the field could not be rewound at all.
  it('replays identically when seeked backwards', () => {
    const feed = createSimFeed({ seed: 4242 })

    const forward = feed.seek(300)
    feed.seek(50)
    const again = feed.seek(300)

    expect(again.nodes).toEqual(forward.nodes)
    expect(again.commitIndex).toBe(forward.commitIndex)
    expect(again.tick).toBe(forward.tick)
  })

  it('gives every in-flight message a live interpolation window', () => {
    const feed = createSimFeed({ seed: 7 })
    const state = feed.seek(300)

    for (const message of state.messages) {
      expect(message.deliverAt).toBeGreaterThan(message.sentAt)
      expect(message.sentAt).toBeLessThanOrEqual(state.tick)
    }
  })

  it('marks committed cells with the tick they committed on', () => {
    const feed = createSimFeed({ seed: 20260811 })
    const state = feed.seek(400)

    for (const node of state.nodes) {
      for (const cell of node.log) {
        if (cell.state === 'committed') expect(cell.committedAt).toBeTypeOf('number')
        else expect(cell.committedAt).toBeUndefined()
      }
    }
  })

  it('colours vote traffic apart from replication traffic', () => {
    const feed = createSimFeed({ seed: 31337 })
    const kinds = new Set<string>()

    for (let t = 1; t <= 400; t++) {
      for (const message of feed.seek(t).messages) kinds.add(message.kind)
    }

    expect(kinds).toContain('vote')
    expect(kinds).toContain('append')
  })

  it('produces drops to disintegrate when the network is lossy', () => {
    const feed = createSimFeed({ seed: 5, dropPercent: 40 })
    let seen = 0

    for (let t = 1; t <= 300; t++) seen += feed.seek(t).drops.length

    expect(seen).toBeGreaterThan(0)
  })
})
