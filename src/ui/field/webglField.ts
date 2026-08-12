import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

import type { NodeId } from '../../raft/types'
import type { NodeView, ViewState } from '../viewModel'
import { arcPoint, dropProgress, jitter, NODE_RADIUS, riftBetween, ringLayout } from './geometry'
import type { Point, Rift } from './geometry'
import type { DrawOptions, FieldRenderer } from './renderer'

/**
 * The WebGL node field.
 *
 * Three material moments, and nothing else asked to carry meaning:
 *
 *   1. A node holding uncommitted entries is glass — translucent, refractive.
 *      When those entries commit it turns solid bone. That transition *is* the
 *      crystallization, staggered down the cluster exactly as the ledger's is.
 *   2. The leader is a real light. The amber falling on the other nodes is cast
 *      by it, not painted on them, so killing the leader genuinely darkens the
 *      field.
 *   3. Messages are emissive and bloom through a post pass, rather than faking
 *      light with a stack of fading alpha dots.
 *
 * World units are CSS pixels at z = 0, so the ring layout, the bezier arcs and
 * the rift crossing are the *same* numbers the 2D renderer uses — shared from
 * geometry.ts rather than reimplemented. A message dies on the rift at the same
 * parameter in both.
 *
 * The camera is tilted a few degrees. Enough for the rift to read as a volume
 * and for the glass to catch a highlight; not enough to turn an instrument into
 * a diorama.
 */

const COLOR = {
  leader: 0xe5a23c,
  cand: 0x9b8cf0,
  follow: 0x586279,
  oxide: 0xc25438,
  ink: 0xe8e3d6,
  dead: 0x2a3044,
} as const

/** Ticks. Matches the ledger's 0.55s crystallize and its 70ms per-row stagger. */
const CRYSTALLIZE_TICKS = 11
const STAGGER_TICKS = 1.4

const MAX_MESSAGES = 64
const MAX_PARTICLES = 160
const CAMERA_TILT = 0.17

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function roleColor(node: NodeView): number {
  if (!node.alive) return COLOR.dead
  if (node.role === 'leader') return COLOR.leader
  if (node.role === 'candidate') return COLOR.cand
  return COLOR.follow
}

/**
 * How solid a node is, 0 = glass, 1 = settled bone.
 *
 * Derived from the timestamps in the snapshot, never accumulated, so scrubbing
 * the feed backwards rewinds the crystallization instead of stranding it.
 */
export function solidity(node: NodeView, time: number, row: number): number {
  const uncommitted = node.log.some((cell) => cell.state === 'uncommitted' || cell.state === 'divergent')
  if (uncommitted) return 0
  if (node.log.length === 0) return 0

  const settledAt = node.log.reduce((latest, cell) => Math.max(latest, cell.committedAt ?? 0), 0)
  if (settledAt === 0) return 1

  const age = time - settledAt - row * STAGGER_TICKS
  if (age <= 0) return 0
  return clamp01(age / CRYSTALLIZE_TICKS)
}

interface Label {
  readonly sprite: THREE.Sprite
  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture
  last: string
}

export function createWebglField(canvas: HTMLCanvasElement): FieldRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, 1, 10, 6000)

  /**
   * Something for the glass to bend.
   *
   * Transmission refracts whatever is *behind* the surface, and with an empty
   * scene that is nothing — a fully refractive node reads as a flat dark ball.
   * A backdrop carrying the same deep-ink gradient as the panel behind it, plus
   * a dim environment for specular, is what makes moment 1 legible: the links
   * and messages passing behind a node visibly distort through it.
   */
  function gradientTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(32, 28, 2, 32, 32, 34)
    grad.addColorStop(0, '#1e2740')
    grad.addColorStop(0.6, '#0f1420')
    grad.addColorStop(1, '#090b12')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    const texture = new THREE.CanvasTexture(c)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  const backdropTexture = gradientTexture()
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: backdropTexture, toneMapped: false, depthWrite: false }),
  )
  backdrop.position.z = -560
  scene.add(backdrop)

  const envTexture = gradientTexture()
  envTexture.mapping = THREE.EquirectangularReflectionMapping
  // PMREM uploads through a 3D texture path, which rejects a flipped source.
  envTexture.flipY = false
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromEquirectangular(envTexture).texture
  scene.environmentIntensity = 1.1
  envTexture.dispose()

  let width = 1
  let height = 1
  let composer: EffectComposer | null = null
  let bloom: UnrealBloomPass | null = null

  // A floor of light so nothing is pure black, then the leader on top of it.
  scene.add(new THREE.AmbientLight(0x9fb0d0, 0.55))
  const rim = new THREE.DirectionalLight(0x8ea0c8, 0.5)
  rim.position.set(-0.4, 0.8, 1)
  scene.add(rim)

  /**
   * Moment 2: the leader is a light, not a colour.
   *
   * Decay 1, not the physical 2, and that is deliberate. World units are CSS
   * pixels: the leader's own surface is ~50 units from the light while its
   * neighbours are ~350. Under inverse-square that is a 40x difference — the
   * leader blows to white before a follower is lit at all. Linear falloff keeps
   * the ratio near 7x, so the leader reads amber and the far side of the ring
   * still visibly receives less light than the near side.
   */
  const leaderLight = new THREE.PointLight(COLOR.leader, 0, 1700, 1)
  scene.add(leaderLight)

  // --- Nodes -------------------------------------------------------------

  const nodeGeometry = new THREE.IcosahedronGeometry(NODE_RADIUS, 4)
  const nodes = new Map<NodeId, { mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial; label: Label }>()

  function makeLabel(): Label {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 128
    const texture = new THREE.CanvasTexture(c)
    texture.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
    )
    sprite.scale.set(96, 48, 1)
    scene.add(sprite)
    return { sprite, canvas: c, texture, last: '' }
  }

  function paintLabel(label: Label, id: string, caption: string, alive: boolean): void {
    const key = `${id}|${caption}|${alive}`
    if (label.last === key) return
    label.last = key

    const ctx = label.canvas.getContext('2d')!
    ctx.clearRect(0, 0, 256, 128)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = alive ? '#E8E3D6' : '#3E4659'
    ctx.font = '500 46px "IBM Plex Mono", monospace'
    ctx.fillText(id, 128, 40)
    ctx.font = '400 26px "IBM Plex Mono", monospace'
    ctx.fillStyle = alive ? 'rgba(232,227,214,.75)' : 'rgba(62,70,89,.9)'
    ctx.fillText(caption, 128, 92)
    label.texture.needsUpdate = true
  }

  function nodeFor(id: NodeId) {
    const existing = nodes.get(id)
    if (existing) return existing

    /**
     * Moment 1. `transmission` is what makes this glass rather than merely
     * see-through: light bends through the body, so an uncommitted node
     * distorts what is behind it. Committed nodes drop transmission to zero and
     * become opaque bone — the same "settled, permanent" semantic the ledger
     * uses, in a material instead of a fill.
     */
    const material = new THREE.MeshPhysicalMaterial({
      color: COLOR.follow,
      roughness: 0.18,
      metalness: 0,
      transmission: 1,
      thickness: NODE_RADIUS * 2.2,
      ior: 1.5,
      transparent: true,
      clearcoat: 0.7,
      clearcoatRoughness: 0.22,
      // Light crossing the body picks up the violet the ledger uses for a
      // provisional entry, so the material says "uncommitted" in the same
      // colour the cells do.
      attenuationColor: new THREE.Color(COLOR.cand),
      // Long relative to the body: this tints what passes through, it does not
      // absorb it. Short distances turn a glass node into a black hole.
      attenuationDistance: NODE_RADIUS * 7,
    })
    const mesh = new THREE.Mesh(nodeGeometry, material)
    mesh.renderOrder = 2
    scene.add(mesh)

    const made = { mesh, material, label: makeLabel() }
    nodes.set(id, made)
    return made
  }

  // --- Messages ----------------------------------------------------------

  /**
   * Moment 3. One instanced mesh of emissive spheres; the glow is a real bloom
   * pass over the frame, not seven fading copies trailing behind each head.
   */
  const messageGeometry = new THREE.SphereGeometry(3.4, 12, 12)
  const messageMaterial = new THREE.MeshBasicMaterial({ toneMapped: false })
  const messages = new THREE.InstancedMesh(messageGeometry, messageMaterial, MAX_MESSAGES)
  messages.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  messages.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MESSAGES * 3), 3)
  messages.frustumCulled = false
  scene.add(messages)

  const particleGeometry = new THREE.SphereGeometry(1.9, 6, 6)
  const particleMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true })
  const particles = new THREE.InstancedMesh(particleGeometry, particleMaterial, MAX_PARTICLES)
  particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  particles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3)
  particles.frustumCulled = false
  scene.add(particles)

  // --- Rift --------------------------------------------------------------

  /**
   * The dash pattern from the reference, as an alpha map scrolled along the
   * rift. Same 9-on/7-off rhythm as the 2D field, so the two renderers read as
   * the same instrument rather than two different ones.
   */
  function dashTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 2
    c.height = 32
    const g = c.getContext('2d')!
    g.fillStyle = '#000'
    g.fillRect(0, 0, 2, 32)
    g.fillStyle = '#fff'
    g.fillRect(0, 0, 2, 18)
    const texture = new THREE.CanvasTexture(c)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    return texture
  }

  const riftDashes = dashTexture()

  /** A slab, not a line: it has thickness along the view axis and you can see it. */
  const riftGroup = new THREE.Group()
  const riftMaterial = new THREE.MeshBasicMaterial({
    color: COLOR.oxide,
    transparent: true,
    opacity: 0.06,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  })
  const riftSlab = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), riftMaterial)
  riftGroup.add(riftSlab)

  const riftEdgeMaterial = new THREE.MeshBasicMaterial({
    color: COLOR.oxide,
    transparent: true,
    opacity: 0.3,
    toneMapped: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    alphaMap: riftDashes,
  })
  const riftEdges = new THREE.Group()
  riftGroup.add(riftEdges)
  riftGroup.visible = false
  // Behind the cluster: the rift is the ground the nodes are separated across,
  // not a curtain drawn in front of them.
  riftGroup.renderOrder = -2
  scene.add(riftGroup)

  // --- Rings -------------------------------------------------------------

  const ringMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  const RING_POOL = 24
  const rings: THREE.Mesh[] = []
  for (let i = 0; i < RING_POOL; i++) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(1, 1.02, 64), ringMaterial.clone())
    mesh.visible = false
    mesh.rotation.x = 0
    scene.add(mesh)
    rings.push(mesh)
  }

  // --- Idle links --------------------------------------------------------

  const linkMaterial = new THREE.LineBasicMaterial({
    color: 0x5a647d,
    transparent: true,
    opacity: 0.16,
    toneMapped: false,
  })
  const severedMaterial = new THREE.LineBasicMaterial({
    color: COLOR.oxide,
    transparent: true,
    opacity: 0.09,
    toneMapped: false,
  })
  const links = new THREE.Group()
  scene.add(links)

  // --- Helpers -----------------------------------------------------------

  /** CSS pixel space (y down, origin top-left) to world space (y up, centred). */
  function toWorld(p: Point, z = 0): THREE.Vector3 {
    return new THREE.Vector3(p.x - width / 2, -(p.y - height / 2), z)
  }

  const dummy = new THREE.Object3D()
  const tint = new THREE.Color()
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  function frameCamera(): void {
    // Fit the field height exactly, then tilt slightly so depth reads.
    const distance = height / 2 / Math.tan((camera.fov * Math.PI) / 360)
    camera.position.set(0, -Math.sin(CAMERA_TILT) * distance * 0.55, Math.cos(CAMERA_TILT) * distance)
    camera.lookAt(0, 0, 0)
  }

  return {
    kind: 'webgl',

    resize(nextWidth: number, nextHeight: number, dpr: number): void {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)

      renderer.setPixelRatio(Math.min(dpr, 2))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      frameCamera()
      // Cover the frustum at the backdrop's depth.
      const spread = 2 * (camera.position.z - backdrop.position.z) * Math.tan((camera.fov * Math.PI) / 360)
      backdrop.scale.set(spread * camera.aspect * 1.3, spread * 1.3, 1)

      composer?.dispose()
      composer = new EffectComposer(renderer)
      composer.setPixelRatio(Math.min(dpr, 2))
      composer.setSize(width, height)
      composer.addPass(new RenderPass(scene, camera))
      // Threshold high on purpose: only the emissive message heads, which are
      // pushed above 1, are meant to bloom. Drop it and the whole field lifts
      // into an orange wash — the instrument stops being ink and light and
      // becomes glare.
      bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.45, 0.85)
      composer.addPass(bloom)
      composer.addPass(new OutputPass())
    },

    draw(state: ViewState, options: DrawOptions): void {
      const { reducedMotion } = options
      const layout = ringLayout(
        state.nodes.map((node) => node.id),
        width,
        height,
      )
      const centre: Point = { x: width / 2, y: height / 2 }
      const rift: Rift | null = state.partition ? riftBetween(state.partition, layout) : null

      // --- nodes ---
      let leader: NodeView | undefined
      state.nodes.forEach((node, row) => {
        const entry = nodeFor(node.id)
        const at = layout.get(node.id)
        if (!at) return

        entry.mesh.position.copy(toWorld(at))
        entry.label.sprite.position.copy(toWorld(at, NODE_RADIUS + 4))
        entry.label.sprite.position.y -= NODE_RADIUS + 26

        const solid = reducedMotion
          ? node.log.some((cell) => cell.state === 'uncommitted' || cell.state === 'divergent')
            ? 0
            : 1
          : solidity(node, state.time, row)

        // Glass while provisional, bone once settled.
        // Glass while provisional, bone once settled. Transmission stops short
        // of 1 so some body colour survives — a fully transmissive sphere over
        // a near-black field is indistinguishable from a hole.
        entry.material.transmission = node.alive ? 0.9 * (1 - solid) : 0.08
        entry.material.opacity = node.alive ? 0.72 + solid * 0.28 : 0.92
        entry.material.roughness = 0.16 + solid * 0.32
        entry.material.thickness = NODE_RADIUS * (1.3 - solid)
        entry.material.color.setHex(node.alive ? (solid > 0.5 ? COLOR.ink : roleColor(node)) : COLOR.dead)
        entry.material.emissive.setHex(node.role === 'leader' && node.alive ? COLOR.leader : 0x000000)
        entry.material.emissiveIntensity = node.role === 'leader' && node.alive ? 0.13 : 0

        paintLabel(
          entry.label,
          node.id.replace(/^n/, ''),
          !node.alive ? 'DOWN' : node.role === 'leader' ? 'LEADER' : node.role === 'candidate' ? 'CAND' : `t${node.term}`,
          node.alive,
        )

        if (node.alive && node.role === 'leader') leader = node
      })

      // --- leader light ---
      if (leader) {
        const at = layout.get(leader.id)
        if (at) {
          leaderLight.position.copy(toWorld(at, NODE_RADIUS * 2.4))
          leaderLight.intensity = 1_150
        }
      } else {
        leaderLight.intensity = 0
      }

      // --- links ---
      links.clear()
      const ids = state.nodes.map((node) => node.id)
      const group = (id: NodeId) => state.partition?.findIndex((g) => g.includes(id)) ?? -1
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = layout.get(ids[i])
          const b = layout.get(ids[j])
          if (!a || !b) continue
          const cut = state.partition !== null && group(ids[i]) !== group(ids[j])
          const points: THREE.Vector3[] = []
          for (let s = 0; s <= 16; s++) points.push(toWorld(arcPoint(a, b, centre, s / 16)))
          links.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(points),
              cut ? severedMaterial : linkMaterial,
            ),
          )
        }
      }

      // --- messages ---
      let live = 0
      for (const message of state.messages) {
        if (live >= MAX_MESSAGES) break
        const span = Math.max(1, message.deliverAt - message.sentAt)
        const progress = (state.time - message.sentAt) / span
        if (progress < 0 || progress > 1) continue

        const from = layout.get(message.from)
        const to = layout.get(message.to)
        if (!from || !to) continue

        const p = arcPoint(from, to, centre, progress)
        // Arcs lift off the plane at their midpoint, so traffic reads as
        // crossing over the field rather than sliding along it.
        const lift = Math.sin(progress * Math.PI) * 26
        dummy.position.copy(toWorld(p, lift))
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        messages.setMatrixAt(live, dummy.matrix)
        // Above 1 so the bloom pass has something to catch.
        tint.setHex(message.kind === 'vote' ? COLOR.cand : COLOR.leader).multiplyScalar(3.4)
        messages.setColorAt(live, tint)
        live += 1
      }
      messages.count = live
      messages.instanceMatrix.needsUpdate = true
      if (messages.instanceColor) messages.instanceColor.needsUpdate = true

      // --- disintegration ---
      let dust = 0
      for (const drop of state.drops) {
        const age = state.time - drop.at
        const life = reducedMotion ? 1 : 9
        if (age < 0 || age > life) continue

        const from = layout.get(drop.from)
        const to = layout.get(drop.to)
        if (!from || !to) continue

        // The same helper the 2D renderer uses, so the two cannot disagree
        // about where a message dies.
        const where = dropProgress(drop.cause, from, to, centre, rift)
        const origin = arcPoint(from, to, centre, where)
        const lift = Math.sin(where * Math.PI) * 26
        const fade = 1 - age / life

        for (let k = 0; k < 6 && dust < MAX_PARTICLES; k++) {
          const seed = drop.key.length * 31 + k
          const spread = reducedMotion ? 3 : age * 2.4
          dummy.position.copy(
            toWorld(
              { x: origin.x + jitter(seed) * spread, y: origin.y + jitter(seed + 91) * spread + age * 0.6 },
              lift + jitter(seed + 17) * spread * 0.6,
            ),
          )
          dummy.scale.setScalar(Math.max(0.25, fade))
          dummy.updateMatrix()
          particles.setMatrixAt(dust, dummy.matrix)
          tint.setHex(COLOR.oxide).multiplyScalar(1.6 * fade)
          particles.setColorAt(dust, tint)
          dust += 1
        }
      }
      particles.count = dust
      particles.instanceMatrix.needsUpdate = true
      if (particles.instanceColor) particles.instanceColor.needsUpdate = true

      // --- pulses ---
      let ring = 0
      for (const pulse of state.pulses) {
        if (ring >= RING_POOL || reducedMotion) break
        const age = state.time - pulse.at
        if (age < 0) continue

        // Same register split as the 2D field, including the cadence rule:
        // commit fires about once a second under load, so it stays instrument
        // scale here too. Only leader-elected is allowed to bloom.
        const spec =
          pulse.kind === 'heartbeat'
            ? { life: 10, color: COLOR.leader, grow: 1.3, alpha: 0.28 }
            : pulse.kind === 'receive'
              ? { life: 5, color: COLOR.ink, grow: 0.6, alpha: 0.3 }
              : pulse.kind === 'elected'
                ? { life: 26, color: COLOR.leader, grow: 5.5, alpha: 0.75 }
                : { life: 12, color: COLOR.ink, grow: 2, alpha: 0.3 }

        if (age > spec.life) continue
        const at = layout.get(pulse.node)
        if (!at) continue

        const t = age / spec.life
        const eased = pulse.kind === 'elected' ? easeOutCubic(t) : t
        const radius = NODE_RADIUS + eased * NODE_RADIUS * spec.grow

        const mesh = rings[ring]
        mesh.visible = true
        mesh.position.copy(toWorld(at))
        mesh.scale.setScalar(radius)
        const material = mesh.material as THREE.MeshBasicMaterial
        material.color.setHex(spec.color)
        material.opacity = spec.alpha * (1 - t)
        ring += 1
      }
      for (let i = ring; i < RING_POOL; i++) rings[i].visible = false

      // --- rift ---
      if (rift) {
        riftGroup.visible = true
        const reach = Math.hypot(width, height)
        const at = toWorld(rift.at)
        riftGroup.position.copy(at)
        // The rift plane contains the view axis, so extruding along z gives it
        // volume without moving where an arc crosses it in xy.
        riftGroup.rotation.z = -Math.atan2(rift.normal.y, rift.normal.x)
        /**
         * A wall about three node-radii thick and three deep. Depth has to be
         * proportionate to the cluster: a slab 200 units deep seen at a tilt
         * projects into a band wider than the ring and buries everything
         * behind it. Thin enough to read as a fault, thick enough that the
         * tilt shows it is a volume.
         */
        riftSlab.scale.set(16, reach * 1.7, 62)
        riftMaterial.opacity = reducedMotion ? 0.05 : 0.04 + Math.sin(state.time * 0.12) * 0.012

        riftDashes.repeat.set(1, (reach * 1.7) / 34)
        riftDashes.offset.y = reducedMotion ? 0 : -state.time * 0.05

        if (riftEdges.children.length === 0) {
          for (let side = -1; side <= 1; side += 2) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), riftEdgeMaterial)
            bar.position.x = side * 8
            riftEdges.add(bar)
          }
        }
        for (const bar of riftEdges.children) bar.scale.set(1.4, reach * 1.7, 62)
      } else {
        riftGroup.visible = false
      }

      if (composer) composer.render()
      else renderer.render(scene, camera)
    },

    pick(state: ViewState, x: number, y: number): NodeId | null {
      pointer.set((x / width) * 2 - 1, -(y / height) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)

      const meshes: THREE.Mesh[] = []
      const owner = new Map<THREE.Mesh, NodeId>()
      for (const node of state.nodes) {
        const entry = nodes.get(node.id)
        if (!entry) continue
        meshes.push(entry.mesh)
        owner.set(entry.mesh, node.id)
      }

      const hit = raycaster.intersectObjects(meshes, false)[0]
      return hit ? (owner.get(hit.object as THREE.Mesh) ?? null) : null
    },

    dispose(): void {
      composer?.dispose()
      riftDashes.dispose()
      pmrem.dispose()
      backdropTexture.dispose()
      nodeGeometry.dispose()
      messageGeometry.dispose()
      particleGeometry.dispose()
      for (const entry of nodes.values()) {
        entry.material.dispose()
        entry.label.texture.dispose()
        entry.label.sprite.material.dispose()
      }
      renderer.dispose()
    },
  }
}
