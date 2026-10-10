// 3D view of the arm (three.js), filling the window behind every tab's panels:
// live arm from /status, a translucent "ghost" for previews, the tool path of a
// sequence, and mouse teleoperation:
//   Tool drag   move a gizmo on the fingertip, tilt it with the ring around
//               it; IK solves the arm (ghost), stopping at the edge of reach
//   Joint drag  click a link, drag its ring to turn that one joint
// In Preview mode the robot moves on "Move"; in Live mode it follows the drag.
// Robot frame: +Z up, +X forward at J1 = 0, millimetres.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { approachYaw, jointFrames, nearestReachable, type NearestResult, type Vec3 } from '@shared/kinematics'
import { uid, type Pose, type Position } from '@shared/types'
import { ArmModel, v3 } from './armModel'
import {
  allCalibrated, api, cal, fmt, jointLimits, kick, on, pref, request, seg, setPref,
  showToast, state, statusDegrees, type Seg
} from './core'
import { promptText } from './dialog'
import { makeFloor } from './floor'
import { changed, lib, nextName } from './library'

const Y_AXIS = new THREE.Vector3(0, 1, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const ZERO = [0, 0, 0, 0, 0]
const RING_R = [110, 86, 70, 56, 48]
const TOOL_RING_R = 80  // the pitch ring around the fingertip
const MARK_DEG = 40  // the + / − arrows on the joint ring sweep this far each way
const BADGE_MM = 34  // size of their + / − badges
const PLANAR_TOL = 0.5  // deg: approach this close to the arm plane counts as planar

type Mode = 'view' | 'tool' | 'joint'
export type ViewHost = 'control' | 'positions' | 'sequences' | 'calibrate' | 'settings'
const TELE_HOSTS: ViewHost[] = ['control', 'positions']  // tabs with mouse teleoperation

export class ArmView {
  readonly root = document.createElement('div')
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(38, 1, 5, 20000)
  private orbit: OrbitControls
  private gizmo: TransformControls
  private live = new ArmModel(false)
  private ghost = new ArmModel(true)
  private grid = new THREE.Group()
  private trail: THREE.Line
  private trailPts: THREE.Vector3[] = []
  private path = new THREE.Group()
  private handle: THREE.Mesh
  private ring: THREE.Mesh
  private ringPick: THREE.Mesh
  private ringMarks = new THREE.Group()  // + / − arrows around the ring, in ring units
  private raf = 0
  private lastFrame = 0

  // Live arm, eased toward the latest reading
  private liveTarget: number[] | null = null
  private liveShown = ZERO.slice()
  private servo = 1500

  // Previews set by the active view
  private previewDeg: number[] | null = null
  private host: ViewHost = 'control'
  private insets = [0, 0]  // px of the view covered by the panels on its left and right

  // Teleoperation
  private mode: Mode = 'view'
  private follow: 'preview' | 'live' = pref('a3follow', 'preview')
  private speedPct: number = pref('a3speed', 30)
  private snap: number = pref('a3snap', 5)
  private target: Pose = { x: 0, y: 0, z: 0, pitch: 0, yaw: null }
  private want: Vec3 = [0, 0, 0]  // where the tool was asked to be; target is the nearest pose in reach
  private clamped = false
  private toolSol: NearestResult | null = null
  private lastGoodSol: number[] | null = null
  private jointDeg: number[] | null = null
  private jointSel = 0
  private ringHot = false  // the pointer is over the ring
  private ringDrag: { axis: THREE.Vector3; pivot: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3
                      start: number; prev: number; acc: number } | null = null
  private liveBusy = false
  private livePending = false
  private liveTimer = 0
  private lastSent = 0

  private segMode!: Seg<Mode>

  constructor(host: HTMLElement) {
    this.root.className = 'arm3d'
    host.appendChild(this.root)
    this.root.innerHTML = `
      <div class="a3-stage"></div>
      <div class="a3-chrome">
        <div class="a3-top">
          <div class="a3-bar card">
            <span class="badge sim a3-mode" title="Not connected: this is the simulated arm">Simulation</span>
            <div class="grp a3-mouse"><span class="lbl">Mouse</span><div data-r="mode"></div></div>
          </div>
          <div class="a3-msg" data-r="msg" hidden></div>
        </div>
        <div class="a3-bottom">
          <div class="a3-hud card" data-r="hud" hidden>
            <div class="a3-opts">
              <div class="grp"><span class="lbl">Follow</span><div data-r="follow"></div></div>
              <div class="grp"><span class="lbl">Snap</span><div data-r="snap"></div></div>
              <label class="grp speed"><span class="lbl">Speed</span>
                <input type="range" min="5" max="100" step="5" data-r="speed"/><span class="mono" data-r="speedv"></span></label>
            </div>
            <div class="a3-tool" data-r="toolhud">
              ${['x', 'y', 'z', 'pitch', 'yaw'].map(k => `<label class="field"><span>${k === 'pitch' ? 'Pitch' : k === 'yaw' ? 'Yaw' : k.toUpperCase()}</span>
                <span class="inp"><input type="number" step="any" data-t="${k}" ${k === 'yaw' ? 'placeholder="auto"' : ''}/><i>${k.length > 1 ? '°' : 'mm'}</i></span></label>`).join('')}
            </div>
            <div class="a3-joints" data-r="jointhud">
              ${[1, 2, 3, 4, 5].map(i => `<label class="a3-j" data-j="${i}"><span class="jtag">J${i}</span>
                <input type="range" step="0.5" data-jr="${i}"/><span class="mono" data-jv="${i}">—</span></label>`).join('')}
            </div>
            <div class="result" data-r="res"></div>
            <div class="actions">
              <button type="button" class="btn ghost sm" data-r="reset">Reset to arm</button>
              <button type="button" class="btn sm" data-r="save">Save as position</button>
              <span class="grow"></span>
              <button type="button" class="btn primary" data-r="go">Move &#9656;</button>
            </div>
          </div>
          <div class="a3-cams">
            <button type="button" class="btn sm" data-cam="iso">Iso</button>
            <button type="button" class="btn sm" data-cam="front">Front</button>
            <button type="button" class="btn sm" data-cam="side">Side</button>
            <button type="button" class="btn sm" data-cam="top">Top</button>
            <button type="button" class="btn sm" data-r="trail" title="Show the recent tool path">Trail</button>
          </div>
          <div class="a3-help" data-r="help"></div>
        </div>
      </div>`

    const stage = this.q('.a3-stage')
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.shadowMap.enabled = true
    stage.append(this.renderer.domElement)

    this.camera.up.set(0, 0, 1)
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.addEventListener('change', () => this.invalidate())
    this.setCamera(pref('a3cam', 'iso'))

    // The sun casts the arm's shadow; a weak light from the other side keeps
    // the faces turned away from it readable
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x24343a, 1.5))
    const sun = new THREE.DirectionalLight(0xffffff, 2.1)
    sun.position.set(500, -700, 1500)
    sun.target.position.set(0, 0, 300)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.radius = 3
    sun.shadow.normalBias = 1.5
    const lit = sun.shadow.camera  // covers the arm's reach
    lit.left = lit.bottom = -850
    lit.right = lit.top = 850
    lit.near = 200
    lit.far = 3200
    const fill = new THREE.DirectionalLight(0x9fdcea, 0.55)
    fill.position.set(-600, 700, 400)
    this.scene.add(sun, sun.target, fill)
    this.scene.add(this.grid, this.live.group, this.ghost.group, this.path)
    this.ghost.group.visible = false

    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffaa00 }))
    this.trail.visible = pref('a3trail', false)
    this.scene.add(this.trail)

    this.handle = new THREE.Mesh(new THREE.SphereGeometry(12, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }))
    this.handle.renderOrder = 5
    this.handle.visible = false
    this.scene.add(this.handle)

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement)
    this.gizmo.setSpace('world')
    this.gizmo.setSize(0.9)
    this.gizmo.addEventListener('change', () => this.invalidate())
    this.gizmo.addEventListener('dragging-changed', e => {
      this.orbit.enabled = !e.value
      if (!e.value) this.flushLive()
    })
    this.gizmo.addEventListener('objectChange', () => this.onHandleMoved())
    this.scene.add(this.gizmo.getHelper())

    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 10, 96),
      new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false, transparent: true, opacity: 0.95 }))
    this.ring.renderOrder = 6
    this.ringPick = new THREE.Mesh(new THREE.TorusGeometry(1, 0.16, 6, 48),
      new THREE.MeshBasicMaterial({ visible: false }))
    this.ring.add(this.ringPick)
    this.ring.visible = false
    this.ringMarks.visible = false
    this.scene.add(this.ring, this.ringMarks)

    this.buildUi()
    this.applyTheme()
    const sizes = new ResizeObserver(() => this.resize())
    for (const el of [stage, this.q('.a3-top'), this.q('.a3-bottom')]) sizes.observe(el)

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', e => this.onPointerDown(e), { capture: true })
    el.addEventListener('pointermove', e => this.onPointerMove(e))
    el.addEventListener('pointerup', e => this.onPointerUp(e))
    el.addEventListener('pointerleave', () => this.setRingHot(false))
    el.addEventListener('wheel', e => this.onWheel(e), { capture: true, passive: false })

    on('status', d => this.setLive(statusDegrees(d), d.servo ?? this.servo))
    on('calib', () => { this.updateMessage(); this.refreshJointHud(); this.setLive(statusDegrees(), this.servo) })
    on('estop', () => this.cancelLive())
    on('mode', () => {  // a different arm: drop mouse control, ghost and trail
      this.setMode('view')
      this.liveTarget = null
      this.trailPts = []
      this.trail.geometry.setFromPoints([])
      this.updateMessage()
    })
    window.addEventListener('keydown', e => this.onKey(e))
    this.updateMessage()
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string) {
    return (sel.startsWith('.') ? this.root.querySelector(sel) : this.root.querySelector(`[data-r="${sel}"]`)) as T
  }

  /** The tab now shown over the view */
  setHost(host: ViewHost) {
    if (this.host !== host) this.setMode('view')
    this.host = host
    this.root.classList.toggle('no-tele', !TELE_HOSTS.includes(host))
    this.previewDeg = null
    this.setPath([])
    this.updateGhost()
  }

  /** Width of the view covered by the panels on each side: the arm and the
   *  view's own controls are centred in what is left */
  setInsets(left: number, right: number) {
    if (left === this.insets[0] && right === this.insets[1]) return
    this.insets = [left, right]
    this.root.style.setProperty('--inset-l', left + 'px')
    this.root.style.setProperty('--inset-r', right + 'px')
    this.resize()
  }

  private css(name: string): string {
    return getComputedStyle(this.root).getPropertyValue(name).trim() || '#888'
  }

  // ── Live arm ───────────────────────────────────────────────────────────────
  private setLive(deg: number[] | null, servo: number) {
    this.servo = servo
    this.liveTarget = deg
    this.updateMessage()
    if (deg && this.trail.visible) this.pushTrail(deg)
    this.invalidate()
  }

  private pushTrail(deg: number[]) {
    const p = v3(jointFrames(deg).tool)
    const last = this.trailPts[this.trailPts.length - 1]
    if (last && last.distanceTo(p) < 2) return
    this.trailPts.push(p)
    if (this.trailPts.length > 600) this.trailPts.shift()
    this.trail.geometry.setFromPoints(this.trailPts)
  }

  private updateMessage() {
    const ok = !!this.liveTarget && allCalibrated()
    const msg = this.q('msg')
    msg.hidden = ok
    if (!ok) msg.innerHTML = state.connected === false
      ? 'Robot offline'
      : 'Calibrate J1&ndash;J5 to see the arm. <a href="#calibrate">Open calibration &rarr;</a>'
    this.live.group.visible = ok
    this.root.classList.toggle('locked', !ok)
    if (!ok && this.mode !== 'view') this.setMode('view')
  }

  // ── Previews ───────────────────────────────────────────────────────────────
  /** Ghost arm at fixed joint angles (null hides it) — used outside teleoperation */
  setPreview(deg: number[] | null) {
    this.previewDeg = deg
    this.updateGhost()
  }

  /** Tool path through points; `active` highlights one marker */
  setPath(points: Array<[number, number, number] | null>, active = -1) {
    this.path.clear()
    const pts = points.filter((p): p is [number, number, number] => !!p).map(v3)
    if (pts.length > 1) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: this.css('--accent'), dashSize: 12, gapSize: 7 }))
      line.computeLineDistances()
      this.path.add(line)
    }
    points.forEach((p, i) => {
      if (!p) return
      const hot = i === active
      const dot = new THREE.Mesh(new THREE.SphereGeometry(hot ? 11 : 7, 16, 12),
        new THREE.MeshBasicMaterial({ color: hot ? this.css('--warn') : this.css('--accent') }))
      dot.position.copy(v3(p))
      this.path.add(dot)
      const label = makeLabel(String(i + 1), hot ? this.css('--warn') : this.css('--ink'))
      label.position.copy(v3(p)).add(new THREE.Vector3(0, 0, 26))
      this.path.add(label)
    })
    this.invalidate()
  }

  private updateGhost() {
    let deg: number[] | null = null
    let bad = false
    if (this.mode === 'tool') {
      deg = this.toolSol?.status === 'ok' ? this.toolSol.deg : this.lastGoodSol
      bad = this.toolSol?.status !== 'ok'
    } else if (this.mode === 'joint') {
      deg = this.jointDeg
    } else {
      deg = this.previewDeg
    }
    const edge = this.mode === 'tool' && this.clamped  // held at the edge of reach
    this.ghost.group.visible = !!deg
    if (deg) {
      const c = this.css(bad ? '--danger' : edge ? '--warn' : '--accent')
      this.ghost.update(deg, this.servo)
      this.ghost.setColors(c, c)
    }
    ;(this.handle.material as THREE.MeshBasicMaterial).color.set(bad ? this.css('--danger') : edge ? this.css('--warn') : '#ffffff')
    this.updateRing()
    this.invalidate()
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(t => this.frame(t))
  }

  private frame(t: number) {
    this.raf = 0
    const dt = Math.min(0.1, (t - (this.lastFrame || t)) / 1000)
    this.lastFrame = t
    let animating = false
    if (this.liveTarget) {
      const k = Math.min(1, dt * 7)
      for (let j = 0; j < 5; j++) {
        const d = this.liveTarget[j] - this.liveShown[j]
        if (Math.abs(d) > 0.02) { this.liveShown[j] += d * k; animating = true } else this.liveShown[j] = this.liveTarget[j]
      }
      this.live.update(this.liveShown, this.servo)
    }
    if (!this.root.isConnected) return
    if (this.ghost.group.visible) this.ghost.showApartFrom(this.live.group.visible ? this.live : null)
    this.renderer.render(this.scene, this.camera)
    if (animating) this.invalidate()
    else this.lastFrame = 0
  }

  private resize() {
    const stage = this.q('.a3-stage')
    const w = stage.clientWidth, h = stage.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // The arm is framed in what the side panels and the view's own controls leave clear.
    // Narrow free areas widen the vertical field of view so the arm still fits sideways
    const [left, right] = this.insets
    const top = this.q('.a3-top').offsetHeight, bottom = this.q('.a3-bottom').offsetHeight
    const fov = 38, minAspect = 0.85, free = Math.max(w - left - right, 1) / h
    this.camera.fov = free >= minAspect ? fov
      : Math.min(70, 2 * Math.atan(Math.tan(fov * Math.PI / 360) * minAspect / free) * 180 / Math.PI)
    this.camera.setViewOffset(w, h, (right - left) / 2, (bottom - top) / 2, w, h)
    this.invalidate()
  }

  private applyTheme() {
    const background = this.css('--view-bg')
    this.scene.background = new THREE.Color(background)
    // The accent on the live arm is trim only; a whole arm in it is the ghost
    this.live.setColors(this.css('--arm-shell'), this.css('--arm-joint'), this.css('--accent'))
    this.grid.clear()
    this.grid.add(makeFloor(1400, 50, { ground: this.css('--view-ground'), background, grid: this.css('--view-grid') }))
    const axes: Array<[string, Vec3]> = [['--ax-x', [180, 0, 0]], ['--ax-y', [0, 180, 0]], ['--ax-z', [0, 0, 180]]]
    for (const [c, end] of axes) {
      this.grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v3(end)]),
        new THREE.LineBasicMaterial({ color: this.css(c), depthTest: false })))
    }
    ;(this.trail.material as THREE.LineBasicMaterial).color.set(this.css('--warn'))
    this.buildRingMarks()
    this.updateGhost()
  }

  setCamera(name: string) {
    const views: Record<string, [Vec3, Vec3]> = {
      iso: [[1230, -1110, 1040], [150, 0, 400]],
      front: [[1700, 0, 380], [0, 0, 380]],
      side: [[0, -1700, 380], [0, 0, 380]],
      top: [[160, -1, 1900], [160, 0, 0]]
    }
    const [pos, tgt] = views[name] || views.iso
    this.camera.position.copy(v3(pos))
    this.orbit.target.copy(v3(tgt))
    this.orbit.update()
    setPref('a3cam', name)
    this.invalidate()
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  private buildUi() {
    this.segMode = seg<Mode>(this.q('mode'), [['view', 'Orbit'], ['tool', 'Tool drag'], ['joint', 'Joint drag']], 'view',
      m => this.setMode(m))
    seg<'preview' | 'live'>(this.q('follow'), [['preview', 'Preview'], ['live', 'Live']], this.follow, v => {
      this.follow = v; setPref('a3follow', v); this.cancelLive(); this.updateHud()
    })
    seg(this.q('snap'), [[0, 'Off'], 1, 5, 10], this.snap, v => {
      this.snap = v; setPref('a3snap', v); this.gizmo.setTranslationSnap(v || null)
    })
    this.gizmo.setTranslationSnap(this.snap || null)
    const sp = this.q<HTMLInputElement>('speed')
    sp.value = String(this.speedPct)
    this.q('speedv').textContent = this.speedPct + '%'
    sp.addEventListener('input', () => {
      this.speedPct = +sp.value
      this.q('speedv').textContent = sp.value + '%'
      setPref('a3speed', this.speedPct)
    })

    this.root.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(b =>
      b.addEventListener('click', () => this.setCamera(b.dataset.cam!)))
    const trailBtn = this.q('trail')
    trailBtn.classList.toggle('on', this.trail.visible)
    trailBtn.addEventListener('click', () => {
      this.trail.visible = !this.trail.visible
      this.trailPts = []
      this.trail.geometry.setFromPoints([])
      trailBtn.classList.toggle('on', this.trail.visible)
      setPref('a3trail', this.trail.visible)
      this.invalidate()
    })

    this.root.querySelectorAll<HTMLInputElement>('[data-t]').forEach(inp =>
      inp.addEventListener('change', () => {
        const k = inp.dataset.t as keyof Pose
        const v = parseFloat(inp.value)
        const xyz = ['x', 'y', 'z'].indexOf(k)
        if (k === 'yaw') this.solveTool({ yaw: Number.isFinite(v) ? v : null })
        else if (!Number.isFinite(v)) this.solveTool()
        else if (xyz < 0) this.solveTool({ pitch: v })
        else {
          this.want = [this.target.x, this.target.y, this.target.z]
          this.want[xyz] = v
          this.solveTool()
        }
        this.scheduleLive()
      }))
    this.root.querySelectorAll<HTMLInputElement>('[data-jr]').forEach(inp => {
      inp.addEventListener('input', () => {
        const j = +inp.dataset.jr!
        if (!this.jointDeg) return
        this.selectJoint(j)
        this.jointDeg[j - 1] = +inp.value
        this.onJointChanged()
      })
      inp.addEventListener('change', () => this.flushLive())
    })
    this.q('reset').addEventListener('click', () => this.resetTarget())
    this.q('save').addEventListener('click', () => this.saveAsPosition())
    this.q('go').addEventListener('click', () => this.moveToGhost())
    this.updateHud()
  }

  private setMode(m: Mode) {
    if (m !== 'view' && (!allCalibrated() || !statusDegrees())) {
      showToast('Mouse control needs J1–J5 calibrated', 'err')
      m = 'view'
    }
    this.cancelLive()
    this.mode = m
    if (this.segMode && this.segMode.value !== m) this.segMode.set(
      [['view', 'Orbit'], ['tool', 'Tool drag'], ['joint', 'Joint drag']], m)
    this.jointSel = 0
    this.ringDrag = null
    if (m !== 'tool') {
      this.gizmo.detach()
      this.handle.visible = false
    }
    if (m === 'view') this.jointDeg = null
    else this.resetTarget()
    this.updateHud()
    this.updateGhost()
  }

  private updateHud() {
    const tele = this.mode !== 'view'
    this.q('hud').hidden = !tele
    this.q('toolhud').hidden = this.mode !== 'tool'
    this.q('jointhud').hidden = this.mode !== 'joint'
    this.q('go').hidden = this.follow === 'live'
    this.q('help').textContent =
      this.mode === 'tool' ? 'Drag the arrows / planes to move · Ring or Shift+wheel: pitch · Enter: move' :
      this.mode === 'joint' ? 'Click a link to pick its joint, then drag the ring · Enter: move' :
      'Drag: orbit · Right-drag: pan · Wheel: zoom'
    if (tele) this.updateResult()
  }

  /** Start teleoperation from where the arm is now */
  private resetTarget() {
    this.cancelLive()
    const deg = statusDegrees()
    if (!deg) return
    if (this.mode === 'tool') {
      const fr = jointFrames(deg), t = fr.approach
      const pitch = Math.atan2(t[2], Math.hypot(t[0], t[1])) * 180 / Math.PI
      const yaw = Math.atan2(t[1], t[0]) * 180 / Math.PI
      const planeYaw = Math.atan2(fr.tool[1], fr.tool[0]) * 180 / Math.PI
      const dy = Math.abs(((yaw - planeYaw + 540) % 360) - 180)
      this.target = { x: fr.tool[0], y: fr.tool[1], z: fr.tool[2], pitch, yaw: dy < PLANAR_TOL ? null : yaw }
      this.want = [...fr.tool]
      this.handle.visible = true
      this.gizmo.attach(this.handle)
      this.lastGoodSol = deg.slice()
      this.toolSol = null
      this.solveTool()
    } else if (this.mode === 'joint') {
      this.jointDeg = deg.slice()
      this.refreshJointHud()
      this.updateGhost()
      this.updateResult()
    }
  }

  // ── Tool drag ──────────────────────────────────────────────────────────────
  private onHandleMoved() {
    const p = this.handle.position
    this.want = [p.x, p.y, p.z]
    this.solveTool()
    this.scheduleLive()
  }

  /** Solve the arm for the wanted position with a new pitch / yaw; out of reach, settle for the nearest pose */
  private solveTool(turn: { pitch?: number; yaw?: number | null } = {}) {
    const { lo, hi } = jointLimits()
    const seed = this.lastGoodSol || statusDegrees() || ZERO
    const t = this.target, had = this.toolSol?.status === 'ok'
    const pose: Pose = { ...t, ...turn, x: this.want[0], y: this.want[1], z: this.want[2] }
    const from: Vec3 | undefined = had ? [t.x, t.y, t.z] : undefined
    let r = nearestReachable(pose, seed, lo, hi, from)
    let short = false
    if (r.status !== 'ok' && had && turn.pitch != null) {  // cannot tilt that far here: tilt as far as it can
      let a = t.pitch, b = turn.pitch
      for (let i = 0; i < 8; i++) {
        const mid = (a + b) / 2
        const rm = nearestReachable({ ...pose, pitch: mid }, seed, lo, hi, from)
        if (rm.status === 'ok') { a = pose.pitch = mid; r = rm; short = true } else b = mid
      }
    }
    if (r.status === 'ok') {
      this.target = { ...pose, x: r.pos[0], y: r.pos[1], z: r.pos[2] }
      this.toolSol = r
      this.lastGoodSol = r.deg
      this.clamped = r.clamped || short
    } else if (had) {
      this.clamped = true  // no way there: stay at the last pose
    } else {
      this.target = pose
      this.toolSol = r
      this.clamped = false
    }
    // The gizmo's handle stays with the arm, also while it is dragged past the edge of reach
    this.handle.position.set(this.target.x, this.target.y, this.target.z)
    this.root.querySelectorAll<HTMLInputElement>('[data-t]').forEach(inp => {
      if (document.activeElement === inp && !this.clamped) return
      const v = this.target[inp.dataset.t as keyof Pose]
      inp.value = v == null ? '' : (+v).toFixed(1)
    })
    this.updateGhost()
    this.updateResult()
  }

  private onWheel(e: WheelEvent) {
    if (this.mode !== 'tool' || !e.shiftKey) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const d = e.deltaY || e.deltaX
    if (!d) return
    this.solveTool({ pitch: Math.max(-180, Math.min(180, Math.round(this.target.pitch) + (d < 0 ? 5 : -5))) })
    this.scheduleLive()
  }

  // ── Rings: joint drag, tool pitch ──────────────────────────────────────────
  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  private onPointerDown(e: PointerEvent) {
    if (this.mode === 'view' || e.button !== 0) return
    const ray = new THREE.Raycaster()
    ray.setFromCamera(this.ndc(e), this.camera)
    const f = this.ringFrame()
    if (f && ray.intersectObject(this.ringPick, false).length) {
      const { axis, pivot } = f
      const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? Z_AXIS : Y_AXIS).normalize()
      const v = new THREE.Vector3().crossVectors(axis, u)
      const start = this.mode === 'tool' ? this.target.pitch : this.jointDeg![this.jointSel - 1]
      const grab = { axis, pivot, u, v, start, prev: 0, acc: 0 }
      const a0 = this.ringAngle(e, grab)
      if (a0 == null) return
      grab.prev = a0
      this.setRingHot(true)  // a touch grabs it without hovering first
      this.ringDrag = grab
      this.orbit.enabled = false
      this.renderer.domElement.setPointerCapture(e.pointerId)
      e.stopImmediatePropagation()
      return
    }
    if (this.mode !== 'joint') return
    const hits = ray.intersectObjects([...this.ghost.parts, ...this.live.parts], false)
      .filter(h => h.object.parent?.visible)
    if (hits.length) {
      this.selectJoint(hits[0].object.userData.joint)
      e.stopImmediatePropagation()
    }
  }

  /** The ring to show: around the picked joint's axis, or around the fingertip to tilt the tool */
  private ringFrame(): { axis: THREE.Vector3; pivot: THREE.Vector3; radius: number; ref: THREE.Vector3 } | null {
    if (this.mode === 'joint' && this.jointSel > 0 && this.jointDeg) {
      const fr = jointFrames(this.jointDeg), k = this.jointSel - 1
      const axis = v3(fr.axes[k]).normalize()
      // Arrows start from the link the joint moves
      const ref = v3([fr.approach, unit(fr.elbow, fr.shoulder), fr.axes[3], fr.approach, fr.approach][k])
      if (k === 0) ref.set(fr.wrist[0], fr.wrist[1], 0)
      if (k === 3) ref.crossVectors(v3(fr.axes[4]), axis)  // where J5 tips the tool
      return { axis, pivot: v3(fr.pivots[k]), radius: RING_R[k], ref }
    }
    if (this.mode === 'tool' && this.toolSol?.status === 'ok') {
      // Pitch turns the tool about the horizontal axis square to its heading; arrows start from the tool
      const t = this.target
      const yaw = approachYaw(t, this.toolSol.deg), p = t.pitch * Math.PI / 180
      return {
        axis: new THREE.Vector3(Math.sin(yaw), -Math.cos(yaw), 0), pivot: new THREE.Vector3(t.x, t.y, t.z), radius: TOOL_RING_R,
        ref: new THREE.Vector3(Math.cos(p) * Math.cos(yaw), Math.cos(p) * Math.sin(yaw), Math.sin(p))
      }
    }
    return null
  }

  /** Pointer angle (deg) around the grabbed ring's axis, in the plane basis u, v */
  private ringAngle(e: PointerEvent, d: { axis: THREE.Vector3; pivot: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }): number | null {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(this.ndc(e), this.camera)
    const hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(d.axis, d.pivot), new THREE.Vector3())
    if (!hit) return null
    hit.sub(d.pivot)
    return Math.atan2(hit.dot(d.v), hit.dot(d.u)) * 180 / Math.PI
  }

  /** The ring lights up under the pointer, as the gizmo's handles do, and stays lit while dragged */
  private hoverRing(e: PointerEvent) {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(this.ndc(e), this.camera)
    this.setRingHot(this.ring.visible && !this.gizmo.dragging && ray.intersectObject(this.ringPick, false).length > 0)
  }

  private setRingHot(hot: boolean) {
    if (hot === this.ringHot || this.ringDrag) return
    this.ringHot = hot
    this.renderer.domElement.style.cursor = hot ? 'grab' : ''
    this.updateRing()
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.ringDrag
    if (!d) return this.hoverRing(e)
    const a = this.ringAngle(e, d)
    if (a == null) return
    d.acc += ((a - d.prev + 540) % 360) - 180
    d.prev = a
    let deg = d.start + d.acc
    if (this.snap) deg = Math.round(deg / this.snap) * this.snap
    if (this.mode === 'tool') {
      deg = Math.max(-180, Math.min(180, deg))
      if (deg === this.target.pitch) return
      this.solveTool({ pitch: deg })
      this.scheduleLive()
      return
    }
    if (!this.jointDeg) return
    const c = cal(this.jointSel)
    if (c?.limits) deg = Math.max(c.min, Math.min(c.max, deg))
    this.jointDeg[this.jointSel - 1] = deg
    this.onJointChanged()
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.ringDrag) return
    this.ringDrag = null
    this.orbit.enabled = true
    this.renderer.domElement.releasePointerCapture(e.pointerId)
    this.hoverRing(e)
    this.flushLive()
  }

  private selectJoint(j: number) {
    if (this.mode !== 'joint') return
    this.jointSel = j
    this.root.querySelectorAll('.a3-j').forEach(el => el.classList.toggle('sel', +(el as HTMLElement).dataset.j! === j))
    this.updateRing()
    this.updateResult()
  }

  private onJointChanged() {
    this.refreshJointHud()
    this.updateGhost()
    this.updateResult()
    this.scheduleLive()
  }

  private refreshJointHud() {
    for (let i = 1; i <= 5; i++) {
      const c = cal(i)
      const inp = this.root.querySelector<HTMLInputElement>(`[data-jr="${i}"]`)!
      inp.min = String(c?.limits ? c.min : -180)
      inp.max = String(c?.limits ? c.max : 180)
      const v = this.jointDeg?.[i - 1]
      if (v != null) inp.value = String(v)
      this.root.querySelector(`[data-jv="${i}"]`)!.textContent = v == null ? '—' : fmt(v) + '°'
    }
  }

  private updateRing() {
    const f = this.ringFrame()
    this.ring.visible = this.ringMarks.visible = !!f
    if (!f) this.setRingHot(false)
    if (f) {
      const { axis, radius: r, ref: link } = f
      this.ring.position.copy(f.pivot)
      this.ring.quaternion.setFromUnitVectors(Z_AXIS, axis)
      this.ring.scale.setScalar(r)
      ;(this.ring.material as THREE.MeshBasicMaterial).color.set(this.css(this.ringHot ? '--ring-hot' : '--warn'))

      // Arrows: local X = where they start, Z = axis
      link.addScaledVector(axis, -link.dot(axis))
      if (link.lengthSq() < 1e-6) link.crossVectors(axis, Math.abs(axis.z) < 0.9 ? Z_AXIS : Y_AXIS)
      link.normalize()
      this.ringMarks.matrix.makeBasis(link, new THREE.Vector3().crossVectors(axis, link), axis)
        .scale(new THREE.Vector3(r, r, r)).setPosition(this.ring.position)
      this.ringMarks.matrixWorldNeedsUpdate = true
      for (const o of this.ringMarks.children) if (o instanceof THREE.Sprite) o.scale.setScalar(BADGE_MM / r)
    }
    this.invalidate()
  }

  /** + and − arrows along the joint ring, right-handed about its axis */
  private buildRingMarks() {
    this.ringMarks.clear()
    this.ringMarks.matrixAutoUpdate = false
    const R = 1.22, sweep = MARK_DEG * Math.PI / 180, head = 0.3
    const at = (a: number, r = R) => new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0)
    for (const [sign, color, text] of [[1, this.css('--plus'), '+'], [-1, this.css('--minus'), '−']] as const) {
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })
      const stop = sweep - head / R
      const arc = new THREE.Mesh(new THREE.TorusGeometry(R, 0.03, 8, 24, stop), mat)
      if (sign < 0) arc.rotation.z = -stop
      const coneGeo = new THREE.ConeGeometry(0.09, head, 16)
      coneGeo.translate(0, head / 2, 0)
      const cone = new THREE.Mesh(coneGeo, mat)
      const base = at(sign * stop), tip = at(sign * sweep)
      cone.position.copy(base)
      cone.quaternion.setFromUnitVectors(Y_AXIS, tip.sub(base).normalize())
      const badge = makeBadge(text, color)
      badge.position.copy(at(sign * (sweep + 0.42 / R), R + 0.08))
      for (const o of [arc, cone, badge]) { o.renderOrder = 7; this.ringMarks.add(o) }
    }
    this.updateRing()
  }

  // ── Sending ────────────────────────────────────────────────────────────────
  private command(): { path: string; body: Record<string, number> } | null {
    const speed = this.speedPct / 100
    const joints = (deg: number[]) => {
      const body: Record<string, number> = { speed }
      deg.forEach((v, k) => (body['a' + (k + 1)] = +v.toFixed(2)))
      return { path: '/movejoints', body }
    }
    if (this.mode === 'tool') {
      if (this.toolSol?.status !== 'ok') return null
      if (this.clamped) {  // on the edge of reach the robot's own IK could refuse the pose: send its joints
        const { lo, hi } = jointLimits()
        return joints(this.toolSol.deg.map((v, k) => Math.max(lo[k], Math.min(hi[k], v))))
      }
      const t = this.target
      const body: Record<string, number> = { x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2), pitch: +t.pitch.toFixed(2), speed }
      if (t.yaw != null) body.yaw = +t.yaw.toFixed(2)
      return { path: '/movepose', body }
    }
    if (this.mode === 'joint' && this.jointDeg) return joints(this.jointDeg)
    return null
  }

  private updateResult() {
    const res = this.q('res')
    const go = this.q<HTMLButtonElement>('go')
    let text = '', err = false
    const edge = this.mode === 'tool' && this.clamped
    if (this.mode === 'tool') {
      if (this.toolSol?.status === 'ok') text = (edge ? 'NEAREST REACHABLE ▸ ' : 'REACHABLE ▸ ') + this.toolSol.deg.map((v, i) => `J${i + 1} ${fmt(v)}°`).join('  ')
      else { err = true; text = this.toolSol?.status === 'limits' ? '✕ pose outside joint limits' : '✕ pose unreachable' }
    } else if (this.mode === 'joint') {
      text = this.jointSel ? `J${this.jointSel} selected — drag the ring or its slider` : 'Click a link of the arm to pick a joint'
    }
    res.textContent = text
    res.className = 'result' + (err ? ' err' : edge ? ' warn' : '')
    go.disabled = !this.command()
  }

  private async moveToGhost() {
    const cmd = this.command()
    if (!cmd) return
    if (await api(cmd.path, cmd.body)) showToast(`Moving to the ghost at ${this.speedPct}% speed`)
  }

  private scheduleLive() {
    if (this.follow !== 'live' || this.mode === 'view') return
    this.livePending = true
    if (!this.liveTimer && !this.liveBusy)
      this.liveTimer = window.setTimeout(() => this.pump(), Math.max(0, 200 - (Date.now() - this.lastSent)))
  }

  /** Send the final target right away once a drag ends */
  private flushLive() {
    if (this.follow !== 'live' || !this.livePending) return
    clearTimeout(this.liveTimer)
    this.liveTimer = 0
    this.pump()
  }

  private async pump() {
    this.liveTimer = 0
    if (!this.livePending || this.liveBusy) return
    this.livePending = false
    const cmd = this.command()
    if (!cmd) return
    this.liveBusy = true
    this.lastSent = Date.now()
    const r = await request(cmd.path, cmd.body)
    this.liveBusy = false
    if (!r.ok) { showToast(r.error || 'Move failed', 'err'); this.livePending = false; return }
    kick()
    if (this.livePending) this.scheduleLive()
  }

  private cancelLive() {
    clearTimeout(this.liveTimer)
    this.liveTimer = 0
    this.livePending = false
  }

  private onKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || this.mode === 'view' || this.follow !== 'preview' || !this.root.isConnected) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, button, .modal-back')) return
    e.preventDefault()
    this.moveToGhost()
  }

  private async saveAsPosition() {
    let p: Position | null = null
    const name = await promptText('Save as position', nextName('P', lib.positions.map(x => x.name)))
    if (!name) return
    if (this.mode === 'tool') {
      if (this.toolSol?.status !== 'ok') return showToast('The target pose is not reachable', 'err')
      const t = this.target, r = (v: number) => +v.toFixed(1)
      p = { id: uid(), name, kind: 'pose', pose: { x: r(t.x), y: r(t.y), z: r(t.z), pitch: r(t.pitch), yaw: t.yaw == null ? null : r(t.yaw) },
            gripper: this.servo, updatedAt: Date.now() }
    } else if (this.mode === 'joint' && this.jointDeg) {
      p = { id: uid(), name, kind: 'joints', joints: { unit: 'deg', v: this.jointDeg.map(v => +v.toFixed(2)) },
            gripper: this.servo, updatedAt: Date.now() }
    }
    if (!p) return
    lib.positions.push(p)
    changed()
    showToast(`Saved position ${name}`)
  }
}

const unit = (a: Vec3, b: Vec3): Vec3 => {
  const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], l = Math.hypot(d[0], d[1], d[2]) || 1
  return [d[0] / l, d[1] / l, d[2] / l]
}

/** White glyph on a filled circle (the joint ring's + / − markers) */
function makeBadge(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = color
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill()
  g.font = 'bold 46px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#fff'
  g.fillText(text, 32, 35)
  const map = new THREE.CanvasTexture(c)
  map.colorSpace = THREE.SRGBColorSpace
  return new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false, transparent: true }))
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.font = 'bold 40px ui-monospace, Consolas, monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = color
  g.fillText(text, 32, 34)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }))
  s.scale.set(36, 36, 1)
  s.renderOrder = 7
  return s
}

let instance: ArmView | null = null
/** The shared 3D view */
export function armView(): ArmView {
  if (!instance) {
    instance = new ArmView(document.getElementById('a3-host')!)
    if (import.meta.env.DEV) (window as any).__armView = instance  // for debugging
  }
  return instance
}

