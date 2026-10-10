// Parametric 3D model of the arm, built from the kinematic chain. Shared by the
// 3D view and the joint diagram renderer (scripts/joint-diagrams).

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { jointFrames, KIN, type Vec3 } from '@shared/kinematics'
import { SERVO_MAX, SERVO_MIN } from '@shared/types'

export const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2])
const Y_AXIS = new THREE.Vector3(0, 1, 0)

// Dimensions, mm
const GRIPPER_LEN = 80                // palm -> fingertips
const BASE_H = 42, DECK_H = 68        // top of the fixed base, top of the turntable
const TURN_R = 70                     // turntable radius
const CAP = 5                         // thickness of a joint's end caps
const ROLL_FROM = 78, ROLL_TO = 16    // the roll housing, before the wrist
const MARKER = [16, 10, 14]           // J1 heading mark on the turntable
const PALM = [100, 22, 32]            // across the jaws, along the tool, thick
const FINGER = [8, GRIPPER_LEN - PALM[1] / 2, 20]

// A part turned about +Y, running from y = 0 to y = len; place() poses it between two points
interface Shape { geo: THREE.BufferGeometry; len: number }

/** Solid of revolution through [radius, y] points. Each stretch of the profile
 *  keeps its own normals, so chamfers stay crisp while the sides stay smooth. */
function turned(len: number, profile: Array<[number, number]>): Shape {
  const pts = [[0, 0], ...profile, [0, len]].map(([r, y]) => new THREE.Vector2(r, y))
  const bands = pts.slice(1).map((p, i) => new THREE.LatheGeometry([pts[i], p], 48))
  return { geo: mergeGeometries(bands), len }
}

/** Chamfered rod, tapering from radius r0 to r1 */
const rod = (r0: number, r1: number, len: number, c = 3) =>
  turned(len, [[r0 - c, 0], [r0, c], [r1, len - c], [r1 - c, len]])

const SHAPES: Record<string, Shape> = {
  base: turned(BASE_H, [[94, 0], [98, 4], [98, 9], [84, 13], [84, BASE_H - 4], [80, BASE_H]]),
  turntable: rod(TURN_R, TURN_R, DECK_H - BASE_H),
  column: turned(KIN.D1 - DECK_H, [[50, 0], [54, 4], [54, 14], [40, 72], [40, KIN.D1 - DECK_H]]),
  shoulder: rod(48, 48, 120, 5),
  shoulderCap: rod(34, 34, CAP, 1.5),
  upper: rod(32, 27, KIN.A2),
  elbow: rod(40, 40, 100, 4),
  elbowCap: rod(28, 28, CAP, 1.5),
  forearm: rod(28, 24, KIN.D4 - ROLL_FROM),
  roll: rod(28, 28, ROLL_FROM - ROLL_TO),
  rollBand: rod(29.5, 29.5, 7, 1),
  wristHub: rod(24, 24, 68),
  wristHubCap: rod(17, 17, CAP, 1.5),
  toolLink: rod(17, 14, KIN.D6 - GRIPPER_LEN)
}
const BOX = new THREE.BoxGeometry(1, 1, 1)

function place(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const d = b.clone().sub(a)
  const len = Math.max(d.length(), 1e-3)
  m.position.copy(a)
  m.quaternion.setFromUnitVectors(Y_AXIS, d.divideScalar(len))
  m.scale.set(1, len / m.userData.len, 1)
}

/** Parametric arm built from the kinematic chain */
export class ArmModel {
  group = new THREE.Group()
  parts: THREE.Mesh[] = []
  private body: THREE.MeshStandardMaterial
  private hub: THREE.MeshStandardMaterial
  private accent: THREE.MeshStandardMaterial
  private m: Record<string, THREE.Mesh> = {}

  constructor(ghost: boolean) {
    const mat = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({
      roughness: 0.5, metalness: 0.1,
      // A ghost close to the solid arm is drawn in front of it, rather than the two fighting over depth
      ...(ghost ? { transparent: true, opacity: 0.32, depthWrite: false,
                    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 } : {}), ...o
    })
    this.body = mat({ color: 0xe3e8eb })
    this.hub = mat({ color: 0x2b353b, roughness: 0.62 })
    this.accent = mat({ color: 0x2ec5d8 })
    // name: [material, joint selected when the part is clicked (6: the gripper, which picks the tool)]
    const spec: Record<string, [THREE.Material, number]> = {
      base: [this.hub, 1], turntable: [this.body, 1], marker: [this.accent, 1], column: [this.body, 1],
      shoulder: [this.hub, 2], shoulderCapA: [this.accent, 2], shoulderCapB: [this.accent, 2], upper: [this.body, 2],
      elbow: [this.hub, 3], elbowCapA: [this.accent, 3], elbowCapB: [this.accent, 3], forearm: [this.body, 3],
      roll: [this.hub, 4], rollBand: [this.accent, 4],
      wristHub: [this.hub, 5], wristHubCapA: [this.accent, 5], wristHubCapB: [this.accent, 5],
      toolLink: [this.body, 5], palm: [this.hub, 6], fingerA: [this.body, 6], fingerB: [this.body, 6]
    }
    for (const [name, [material, joint]] of Object.entries(spec)) {
      const shape = SHAPES[name.replace(/Cap[AB]$/, 'Cap')]
      const mesh = new THREE.Mesh(shape?.geo ?? BOX, material)
      mesh.name = name
      mesh.userData.joint = joint
      mesh.userData.len = shape?.len
      mesh.renderOrder = ghost ? 2 : 0
      mesh.castShadow = mesh.receiveShadow = !ghost
      this.m[name] = mesh
      this.parts.push(mesh)
      this.group.add(mesh)
    }
    this.m.marker.scale.fromArray(MARKER)
    this.m.palm.scale.fromArray(PALM)
    this.m.fingerA.scale.fromArray(FINGER)
    this.m.fingerB.scale.fromArray(FINGER)
  }

  /** Links, joint housings and their trim; the trim follows the housings unless given */
  setColors(body: string, hub: string, accent = hub) {
    this.body.color.set(body)
    this.hub.color.set(hub)
    this.accent.color.set(accent)
  }

  /** Show only the parts that are not where the other arm's are (all of them without one):
   *  a ghost lying on the arm it previews has nothing to show there */
  showApartFrom(other: ArmModel | null) {
    for (const [name, part] of Object.entries(this.m)) {
      const twin = other?.m[name]
      part.visible = !twin || part.position.distanceTo(twin.position) > 0.5 ||
        part.quaternion.angleTo(twin.quaternion) > 2e-3
    }
  }

  update(deg: number[], servo: number) {
    const fr = jointFrames(deg)
    const m = this.m
    const t1 = deg[0] * Math.PI / 180
    const shoulder = v3(fr.shoulder), elbow = v3(fr.elbow), wrist = v3(fr.wrist), tool = v3(fr.tool)
    const n = v3(fr.axes[1]), f = v3(fr.axes[3]), a5 = v3(fr.axes[4]), t = v3(fr.approach)
    const up = (z: number) => new THREE.Vector3(0, 0, z)
    const at = (p: THREE.Vector3, dir: THREE.Vector3, d: number) => p.clone().addScaledVector(dir, d)
    // A joint housing centred on its axis, with a cap on each end
    const housing = (name: string, p: THREE.Vector3, axis: THREE.Vector3) => {
      const half = m[name].userData.len / 2
      place(m[name], at(p, axis, -half), at(p, axis, half))
      place(m[name + 'CapA'], at(p, axis, half), at(p, axis, half + CAP))
      place(m[name + 'CapB'], at(p, axis, -half), at(p, axis, -half - CAP))
    }

    place(m.base, up(0), up(BASE_H))
    place(m.turntable, up(BASE_H), up(DECK_H))
    m.marker.position.set(Math.cos(t1) * TURN_R, Math.sin(t1) * TURN_R, (BASE_H + DECK_H) / 2)
    m.marker.rotation.set(0, 0, t1)
    place(m.column, up(DECK_H), shoulder)
    housing('shoulder', shoulder, n)
    place(m.upper, shoulder, elbow)
    housing('elbow', elbow, n)
    const rollStart = at(wrist, f, -ROLL_FROM)
    place(m.forearm, elbow, rollStart)
    place(m.roll, rollStart, at(wrist, f, -ROLL_TO))
    place(m.rollBand, at(rollStart, f, 5), at(rollStart, f, 12))
    housing('wristHub', wrist, a5)
    const palm = at(tool, t, -GRIPPER_LEN)
    place(m.toolLink, wrist, palm)

    // The gripper: X across the jaws, Y along the tool
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(a5, t, new THREE.Vector3().crossVectors(a5, t)))
    m.palm.position.copy(palm)
    m.palm.quaternion.copy(q)
    // Opening grows with the pulse width (assumes more µs = more open)
    const open = 10 + 60 * (Math.min(SERVO_MAX, Math.max(SERVO_MIN, servo)) - SERVO_MIN) / (SERVO_MAX - SERVO_MIN)
    for (const [name, s] of [['fingerA', 1], ['fingerB', -1]] as const) {
      m[name].position.copy(tool).addScaledVector(t, -FINGER[1] / 2).addScaledVector(a5, s * (open + FINGER[0]) / 2)
      m[name].quaternion.copy(q)
    }
  }
}
