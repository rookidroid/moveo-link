// Joint direction diagrams for the README, drawn with the app's 3D arm model.
// Each joint panel shows the arm at a base pose (solid), the same pose with
// the joint turned + and − (blue / orange ghosts), and arrows around the
// joint axis. `npm run diagrams` saves them to docs/joints/.

import * as THREE from 'three'
import { jointFrames, type Vec3 } from '@shared/kinematics'
import { ArmModel, v3 } from '../../src/renderer/lib/armModel'

const W = 640, H = 540, SCALE = 2
const BG = '#f6f7f9'
const INK = '#1d232a', INK_2 = '#5b6570'
const PLUS = '#1f6fd1', MINUS = '#e8730c', ACCENT = '#16a8bb'
const FONT = '"Segoe UI", system-ui, sans-serif'

interface Arrow {
  center: Vec3
  axis: Vec3
  from: Vec3       // direction the arcs start from (perpendicular to axis)
  radius: number
  sweep: number    // degrees each way
  axisHalf?: number
}

interface Panel {
  name: string
  title: string
  caption: string
  deg: number[]
  joint?: number   // 1-5: turned ± `delta` in the ghosts
  delta?: number
  arrow?: (fr: ReturnType<typeof jointFrames>) => Arrow
  range?: [number, number]  // J1 only: allowed angles, drawn on the floor
  camera: [Vec3, Vec3]
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** Unit part of a perpendicular to the unit axis n */
const perp = (a: Vec3, n: Vec3): Vec3 => unit(sub(a, n.map(v => v * dot(a, n)) as Vec3))

const PANELS: Panel[] = [
  {
    name: 'zero', title: 'Zero pose', caption: 'All joints at 0°: the arm points straight up',
    deg: [0, 0, 0, 0, 0], camera: [[1550, -1300, 820], [-60, -110, 400]]
  },
  {
    name: 'j1', title: 'J1 · Base', caption: '+ turns counter-clockwise seen from above · range 0° to 180°',
    deg: [90, 55, 45, 0, 20], joint: 1, delta: 45, range: [0, 180], camera: [[150, -1250, 1750], [0, 170, 120]],
    arrow: () => ({ center: [0, 0, 330], axis: [0, 0, 1], from: [0, 1, 0], radius: 330, sweep: 45, axisHalf: 260 })
  },
  {
    name: 'j2', title: 'J2 · Shoulder', caption: '+ leans the arm forward',
    deg: [0, 0, 50, 0, 40], joint: 2, delta: 30, camera: [[420, -1650, 560], [140, 0, 430]],
    arrow: fr => ({
      center: fr.shoulder, axis: fr.axes[1], from: unit(sub(fr.elbow, fr.shoulder)), radius: 165, sweep: 30
    })
  },
  {
    name: 'j3', title: 'J3 · Elbow', caption: '+ bends the forearm forward',
    deg: [0, 15, 50, 0, 40], joint: 3, delta: 35, camera: [[420, -1650, 560], [170, 0, 430]],
    arrow: fr => ({ center: fr.elbow, axis: fr.axes[2], from: fr.axes[3], radius: 150, sweep: 35 })
  },
  {
    name: 'j4', title: 'J4 · Wrist roll', caption: '+ is right-handed about the forearm (thumb toward the gripper)',
    deg: [0, 30, 60, 0, 50], joint: 4, delta: 60, camera: [[1150, -330, 560], [300, 0, 390]],
    arrow: fr => {
      const f = fr.axes[3]
      const c = sub(fr.wrist, [f[0] * 47, f[1] * 47, f[2] * 47])
      // the arcs start where J5 tips the tool at J4 = 0
      return { center: c, axis: f, from: perp(fr.approach, f), radius: 85, sweep: 60 }
    }
  },
  {
    name: 'j5', title: 'J5 · Wrist pitch', caption: '+ tips the gripper forward (toward the bend of the arm)',
    deg: [0, 30, 60, 0, 0], joint: 5, delta: 45, camera: [[520, -1500, 640], [330, 0, 370]],
    arrow: fr => ({ center: fr.wrist, axis: fr.axes[4], from: fr.approach, radius: 125, sweep: 45 })
  }
]


const HUBS = ['turntable', 'shoulder', 'elbow', 'roll', 'wristHub']
const Y_AXIS = new THREE.Vector3(0, 1, 0)

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(SCALE)
renderer.setSize(W, H)

function arm(deg: number[], kind: 'solid' | 'plus' | 'minus', joint?: number) {
  const m = new ArmModel(kind !== 'solid')
  if (kind === 'solid') m.setColors('#cdd2d8', '#6d7883')
  else m.setColors(kind === 'plus' ? PLUS : MINUS, kind === 'plus' ? PLUS : MINUS)
  for (const p of m.parts) {
    const mat = p.material as THREE.MeshStandardMaterial
    if (kind !== 'solid') mat.opacity = 0.34
  }
  if (kind === 'solid' && joint) {
    const hub = m.parts.find(p => p.name === HUBS[joint - 1])!
    hub.material = new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.5, metalness: 0.1 })
  }
  m.update(deg, 1500)
  return m.group
}

/** Hide ghost parts that coincide with the solid arm (they would only tint it).
 *  Parts are cylinders along their local Y, so a spin about that axis doesn't count. */
function hideUnmoved(ghost: THREE.Group, solid: THREE.Group) {
  for (const part of ghost.children) {
    const twin = solid.getObjectByName(part.name)!
    const axis = (o: THREE.Object3D) => Y_AXIS.clone().applyQuaternion(o.quaternion)
    part.visible = part.position.distanceTo(twin.position) > 0.5 || axis(part).angleTo(axis(twin)) > 1e-3
  }
}

/** Point on the arc at angle a (rad), right-handed about the axis */
function arcPoint(ar: Arrow, a: number, r = ar.radius) {
  const ax = v3(ar.axis).normalize()
  const u = v3(ar.from).normalize()
  const w = new THREE.Vector3().crossVectors(ax, u)
  return v3(ar.center).addScaledVector(u, r * Math.cos(a)).addScaledVector(w, r * Math.sin(a))
}

function arcArrow(ar: Arrow, sign: number, color: string) {
  const g = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })
  const head = 30, headAng = head / ar.radius
  const end = (ar.sweep * Math.PI / 180) * sign
  const stop = end - sign * headAng
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= 40; i++) pts.push(arcPoint(ar, stop * i / 40))
  const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 4.2, 10), mat)
  const coneGeo = new THREE.ConeGeometry(12, head, 20)
  coneGeo.translate(0, head / 2, 0)
  const cone = new THREE.Mesh(coneGeo, mat)
  const base = arcPoint(ar, stop), tip = arcPoint(ar, end)
  cone.position.copy(base)
  cone.quaternion.setFromUnitVectors(Y_AXIS, tip.clone().sub(base).normalize())
  for (const m of [tube, cone]) { m.renderOrder = 10; g.add(m) }
  return g
}

function axisLine(center: Vec3, axis: Vec3, half: number) {
  const c = v3(center), a = v3(axis).normalize()
  const geo = new THREE.BufferGeometry().setFromPoints([c.clone().addScaledVector(a, -half), c.clone().addScaledVector(a, half)])
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color: INK_2, dashSize: 14, gapSize: 9, depthTest: false, transparent: true, opacity: 0.8
  }))
  line.computeLineDistances()
  line.renderOrder = 9
  return line
}

function worldArrow(dir: Vec3, len: number) {
  const a = new THREE.ArrowHelper(v3(dir), new THREE.Vector3(), len, INK_2, 26, 13)
  a.traverse(o => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined
    if (m) { m.depthTest = false; m.transparent = true }
    o.renderOrder = 9
  })
  return a
}

interface Label { at: THREE.Vector3; text: string; kind: 'plus' | 'minus' | 'tag' | 'note' }

function draw(p: Panel): string {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.7))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(600, -900, 1400)
  scene.add(sun)
  const grid = new THREE.GridHelper(1400, 28, 0xc9ced4, 0xe0e3e7)
  grid.rotation.x = Math.PI / 2
  scene.add(grid)

  const camera = new THREE.PerspectiveCamera(30, W / H, 5, 20000)
  camera.up.set(0, 0, 1)
  camera.position.copy(v3(p.camera[0]))
  camera.lookAt(v3(p.camera[1]))
  camera.updateMatrixWorld()

  const labels: Label[] = []
  const fr = jointFrames(p.deg)
  scene.add(arm(p.deg, 'solid', p.joint))

  if (p.joint && p.delta && p.arrow) {
    const j = p.joint - 1
    const plus = p.deg.slice(), minus = p.deg.slice()
    plus[j] += p.delta
    minus[j] -= p.delta
    const solid = scene.children[scene.children.length - 1] as THREE.Group
    for (const ghost of [arm(plus, 'plus'), arm(minus, 'minus')]) {
      hideUnmoved(ghost, solid)
      scene.add(ghost)
    }
    const ar = p.arrow(fr)
    scene.add(axisLine(ar.center, ar.axis, ar.axisHalf ?? ar.radius * 1.35))
    scene.add(arcArrow(ar, 1, PLUS), arcArrow(ar, -1, MINUS))
    if (p.range) {
      const [lo, hi] = p.range.map(d => d * Math.PI / 180)
      const band = new THREE.Mesh(new THREE.RingGeometry(470, 520, 64, 1, lo, hi - lo),
        new THREE.MeshBasicMaterial({ color: INK_2, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }))
      band.position.z = 1
      scene.add(band)
      for (const d of p.range) {
        const a = d * Math.PI / 180
        labels.push({ at: new THREE.Vector3(575 * Math.cos(a), 575 * Math.sin(a), 0), text: `${d}°`, kind: 'note' })
      }
    }
    const off = (ar.sweep * Math.PI / 180) + 26 / ar.radius
    labels.push({ at: arcPoint(ar, off, ar.radius + 4), text: '+', kind: 'plus' })
    labels.push({ at: arcPoint(ar, -off, ar.radius + 4), text: '−', kind: 'minus' })
  } else {
    // Zero pose: world frame and where each joint sits
    scene.add(worldArrow([1, 0, 0], 270), worldArrow([0, 1, 0], 240))
    labels.push({ at: new THREE.Vector3(320, 0, 0), text: '+X forward', kind: 'note' })
    labels.push({ at: new THREE.Vector3(0, 285, 0), text: '+Y', kind: 'note' })
    const at = [v3([0, 0, 46]), v3(fr.shoulder), v3(fr.elbow), v3(fr.pivots[3]), v3(fr.wrist)]
    at.forEach((pt, i) => labels.push({ at: pt, text: `J${i + 1}`, kind: 'tag' }))
  }

  renderer.render(scene, camera)

  const out = document.createElement('canvas')
  out.width = W * SCALE
  out.height = H * SCALE
  const g = out.getContext('2d')!
  g.drawImage(renderer.domElement, 0, 0)
  g.scale(SCALE, SCALE)

  const toScreen = (v: THREE.Vector3) => {
    const n = v.clone().project(camera)
    return [(n.x + 1) / 2 * W, (1 - n.y) / 2 * H]
  }
  for (const l of labels) {
    const [x, y] = toScreen(l.at)
    if (l.kind === 'plus' || l.kind === 'minus') {
      g.fillStyle = l.kind === 'plus' ? PLUS : MINUS
      g.beginPath(); g.arc(x, y, 15, 0, Math.PI * 2); g.fill()
      g.fillStyle = '#fff'
      g.font = `700 24px ${FONT}`
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(l.text, x, y + (l.kind === 'plus' ? 1 : 0))
    } else if (l.kind === 'tag') {
      const tx = x - 62, ty = y
      g.strokeStyle = INK_2; g.lineWidth = 1.2
      g.beginPath(); g.moveTo(x - 6, y); g.lineTo(tx + 20, ty); g.stroke()
      g.fillStyle = INK_2
      g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill()
      g.font = `600 15px ${FONT}`
      g.textAlign = 'left'; g.textBaseline = 'middle'
      roundRect(g, tx - 18, ty - 12, 36, 24, 6, ACCENT)
      g.fillStyle = '#fff'
      g.textAlign = 'center'
      g.fillText(l.text, tx, ty + 0.5)
    } else {
      g.fillStyle = INK_2
      g.font = `500 14px ${FONT}`
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(l.text, x, y)
    }
  }

  g.textAlign = 'left'; g.textBaseline = 'alphabetic'
  g.fillStyle = INK
  g.font = `650 24px ${FONT}`
  g.fillText(p.title, 22, 40)
  g.fillStyle = INK_2
  g.font = `400 15px ${FONT}`
  g.fillText(p.caption, 22, 64)
  if (p.joint && p.delta) {
    const y = H - 20
    g.fillStyle = BG
    g.fillRect(0, H - 40, W, 40)
    let x = 22
    g.font = `400 13px ${FONT}`
    // ghost angles, as absolute joint angles
    const j = p.joint
    const at = (d: number) => `J${j} ${String(p.deg[j - 1] + d).replace('-', '−')}°`
    for (const [c, t] of [[PLUS, at(p.delta)], [MINUS, at(-p.delta)]]) {
      g.fillStyle = c; g.globalAlpha = 0.55
      g.fillRect(x, y - 10, 12, 12)
      g.globalAlpha = 1
      g.fillStyle = INK_2
      g.fillText(t, x + 18, y)
      x += g.measureText(t).width + 40
    }
    g.fillStyle = INK_2
    g.textAlign = 'right'
    g.fillText(`base pose ${p.deg.map(d => Math.round(d)).join(' / ')}°`, W - 22, y)
  }
  return out.toDataURL('image/png')
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  g.fillStyle = fill
  g.beginPath()
  g.roundRect(x, y, w, h, r)
  g.fill()
}

declare global { interface Window { renderDiagrams: () => Array<{ name: string; png: string }> } }

let cache: Array<{ name: string; png: string }> | null = null
window.renderDiagrams = () => (cache ??= PANELS.map(p => ({ name: p.name, png: draw(p) })))

const out = document.getElementById('out')!
for (const d of window.renderDiagrams()) {
  const img = new Image()
  img.src = d.png
  img.title = d.name
  out.appendChild(img)
}
