import { describe, expect, it } from 'vitest'

import {
  arcCrossing,
  arcPoint,
  dropProgress,
  NODE_RADIUS,
  riftBetween,
  ringLayout,
  sideOf,
} from './field/geometry'
import { solidity } from './field/webglField'
import { castFor } from './demo'
import { nodeAtPoint } from './field/render'
import { createMockFeed, MOCK_CYCLE_TICKS } from './mockFeed'
import { createSimFeed } from './simFeed'
import type { LogCellView, NodeView, ViewState } from './viewModel'

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

describe('the rift', () => {
  const layout = ringLayout(IDS, 900, 700)

  it('is null unless the cluster is split in two', () => {
    expect(riftBetween([IDS], layout)).toBeNull()
    expect(riftBetween([['n1'], ['n2'], ['n3']], layout)).toBeNull()
    expect(riftBetween([[], IDS], layout)).toBeNull()
  })

  it('passes through the midpoint of the two centroids', () => {
    const rift = riftBetween([['n1', 'n2'], ['n3', 'n4', 'n5']], layout)!

    expect(sideOf(rift, rift.at)).toBeCloseTo(0, 6)
  })

  // The line must run *across* the split, not along it. Drawing it along the
  // normal instead is a quarter-turn error that still looks plausible until you
  // check which side each node lands on.
  it('separates the two groups when the split is contiguous on the ring', () => {
    const a = ['n1', 'n2']
    const b = ['n3', 'n4', 'n5']
    const rift = riftBetween([a, b], layout)!

    const signs = (group: string[]) => group.map((id) => Math.sign(sideOf(rift, layout.get(id)!)))
    expect(new Set(signs(a))).toEqual(new Set([-1]))
    expect(new Set(signs(b))).toEqual(new Set([1]))
  })

  it('is computed from the groups, so a different split moves it', () => {
    const one = riftBetween([['n1', 'n2'], ['n3', 'n4', 'n5']], layout)!
    const two = riftBetween([['n3', 'n4'], ['n1', 'n2', 'n5']], layout)!

    expect(one.angle).not.toBeCloseTo(two.angle, 3)
  })

  it('finds where an arc crosses it, between the two endpoints', () => {
    const rift = riftBetween([['n1', 'n2'], ['n3', 'n4', 'n5']], layout)!
    const centre = { x: 450, y: 350 }
    const from = layout.get('n1')!
    const to = layout.get('n4')!

    const t = arcCrossing(from, to, centre, rift)
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(0)
    expect(t!).toBeLessThan(1)

    // And the crossing point really is on the line.
    expect(sideOf(rift, arcPoint(from, to, centre, t!))).toBeCloseTo(0, 6)
  })

  it('finds no crossing for an arc that stays on one side', () => {
    const rift = riftBetween([['n1', 'n2'], ['n3', 'n4', 'n5']], layout)!
    const centre = { x: 450, y: 350 }

    expect(arcCrossing(layout.get('n3')!, layout.get('n4')!, centre, rift)).toBeNull()
  })
})

describe('demo cast', () => {
  it('strands the leader with a ring neighbour, never a quorum', () => {
    for (const leader of IDS) {
      const cast = castFor(leader, IDS)

      expect(cast.minority).toHaveLength(2)
      expect(cast.majority).toHaveLength(3)
      expect(cast.minority).toContain(leader)
      expect(cast.minority.length * 2).toBeLessThan(IDS.length)

      // Adjacent on the ring, so the rift can actually separate the sides.
      const gap = Math.abs(IDS.indexOf(cast.minority[0]) - IDS.indexOf(cast.minority[1]))
      expect(gap === 1 || gap === IDS.length - 1).toBe(true)
    }
  })
})

describe('drop placement is shared by both renderers', () => {
  const layout = ringLayout(IDS, 900, 700)
  const centre = { x: 450, y: 350 }
  const rift = riftBetween([['n1', 'n2'], ['n3', 'n4', 'n5']], layout)!
  const from = layout.get('n1')!
  const to = layout.get('n4')!

  // The 2D and WebGL fields call this same function, so they cannot disagree
  // about where a message comes apart.
  it('kills a partitioned message exactly on the rift', () => {
    const t = dropProgress('partition', from, to, centre, rift)

    expect(sideOf(rift, arcPoint(from, to, centre, t))).toBeCloseTo(0, 6)
  })

  it('kills a node-down message at the destination', () => {
    expect(dropProgress('node-down', from, to, centre, rift)).toBe(1)
    expect(arcPoint(from, to, centre, dropProgress('node-down', from, to, centre, null))).toEqual(to)
  })

  it('kills a randomly dropped message in the wire, between the two ends', () => {
    const t = dropProgress('random', from, to, centre, rift)

    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(1)
  })

  it('falls back to mid-arc if a partitioned message somehow never crosses', () => {
    // Both endpoints on the same side: no crossing exists.
    expect(dropProgress('partition', layout.get('n3')!, layout.get('n4')!, centre, rift)).toBe(0.5)
  })
})

describe('node crystallization in 3D', () => {
  function node(log: { state: string; committedAt?: number }[]): NodeView {
    return {
      id: 'n1',
      role: 'follower',
      term: 1,
      alive: true,
      commitIndex: log.length,
      log: log.map((cell, i) => ({
        index: i + 1,
        term: 1,
        label: '1',
        state: cell.state as LogCellView['state'],
        committedAt: cell.committedAt,
      })),
    }
  }

  it('is glass while any entry is uncommitted', () => {
    expect(solidity(node([{ state: 'committed', committedAt: 5 }, { state: 'uncommitted' }]), 100, 0)).toBe(0)
  })

  it('is glass while an entry is divergent and about to be truncated', () => {
    expect(solidity(node([{ state: 'divergent' }]), 100, 0)).toBe(0)
  })

  it('crystallizes to solid over the ledger duration once everything commits', () => {
    const settled = node([{ state: 'committed', committedAt: 100 }])

    expect(solidity(settled, 100, 0)).toBe(0)
    expect(solidity(settled, 105.5, 0)).toBeGreaterThan(0.3)
    expect(solidity(settled, 105.5, 0)).toBeLessThan(0.7)
    expect(solidity(settled, 120, 0)).toBe(1)
  })

  // The same wave the ledger runs, so the field and the panel crystallize together.
  it('staggers down the cluster, later rows lagging earlier ones', () => {
    const settled = node([{ state: 'committed', committedAt: 100 }])
    const rows = [0, 1, 2, 3, 4].map((row) => solidity(settled, 104, row))

    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeLessThanOrEqual(rows[i - 1])
  })

  it('is derived from time, so scrubbing backwards rewinds it', () => {
    const settled = node([{ state: 'committed', committedAt: 100 }])

    expect(solidity(settled, 103, 0)).toBe(solidity(settled, 103, 0))
    expect(solidity(settled, 103, 0)).toBeLessThan(solidity(settled, 108, 0))
  })
})
