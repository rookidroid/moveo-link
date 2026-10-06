// Parametric 3D model of the arm, built from the kinematic chain. Shared by the
// 3D view and the joint diagram renderer (scripts/joint-diagrams).

import * as THREE from 'three'
import { jointFrames, type Vec3 } from '@shared/kinematics'
import { SERVO_MAX, SERVO_MIN } from '@shared/types'

export const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2])
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const GRIPPER_LEN = 80  // palm -> fingertips, mm

// Unit cylinder along +Y, stretched between two points
const CYL = new THREE.CylinderGeometry(1, 1, 1, 28)
function place(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const d = b.clone().sub(a)
  const len = Math.max(d.length(), 1e-3)
  m.position.copy(a).addScaledVector(d, 0.5)
  m.quaternion.setFromUnitVectors(Y_AXIS, d.divideScalar(len))
  m.scale.set(r, len, r)
}

/** Parametric arm built from the kinematic chain */
export class ArmModel {
  group = new THREE.Group()
  parts: THREE.Mesh[] = []
  private body: THREE.MeshStandardMaterial
  private hub: THREE.MeshStandardMaterial
  private m: Record<string, THREE.Mesh> = {}

  constructor(ghost: boolean) {
    const mat = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({
      roughness: 0.55, metalness: 0.1,
      ...(ghost ? { transparent: true, opacity: 0.32, depthWrite: false } : {}), ...o
    })
    this.body = mat({ color: 0xd0d4d8 })
    this.hub = mat({ color: 0x2ec5d8 })
    // name: [material, joint selected when the part is clicked]
    const spec: Record<string, [THREE.Material, number]> = {
      base: [this.body, 1], turntable: [this.hub, 1], marker: [this.body, 1], column: [this.body, 1],
      shoulder: [this.hub, 2], upper: [this.body, 2], elbow: [this.hub, 3], forearm: [this.body, 3],
      roll: [this.hub, 4], wristHub: [this.hub, 5], toolLink: [this.body, 5], palm: [this.body, 5],
      fingerA: [this.hub, 5], fingerB: [this.hub, 5]
    }
    for (const [name, [material, joint]] of Object.entries(spec)) {
      const mesh = new THREE.Mesh(name === 'marker' ? new THREE.BoxGeometry(1, 1, 1) : CYL, material)
      mesh.name = name
      mesh.userData.joint = joint
      mesh.renderOrder = ghost ? 2 : 0
      this.m[name] = mesh
      this.parts.push(mesh)
      this.group.add(mesh)
    }
  }

  setColors(body: string, hub: string) {
    this.body.color.set(body)
    this.hub.color.set(hub)
  }

  update(deg: number[], servo: number) {
    const fr = jointFrames(deg)
    const m = this.m
    const t1 = deg[0] * Math.PI / 180
    const er = new THREE.Vector3(Math.cos(t1), Math.sin(t1), 0)
    const shoulder = v3(fr.shoulder), elbow = v3(fr.elbow), wrist = v3(fr.wrist), tool = v3(fr.tool)
    const n = v3(fr.axes[1]), f = v3(fr.axes[3]), a5 = v3(fr.axes[4]), t = v3(fr.approach)

    place(m.base, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 30), 88)
    place(m.turntable, new THREE.Vector3(0, 0, 30), new THREE.Vector3(0, 0, 62), 64)
    m.marker.position.copy(er).multiplyScalar(64).setZ(46)
    m.marker.rotation.set(0, 0, t1)
    m.marker.scale.set(18, 10, 30)
    place(m.column, new THREE.Vector3(0, 0, 62), shoulder, 34)
    place(m.shoulder, shoulder.clone().addScaledVector(n, -52), shoulder.clone().addScaledVector(n, 52), 38)
    place(m.upper, shoulder, elbow, 25)
    place(m.elbow, elbow.clone().addScaledVector(n, -42), elbow.clone().addScaledVector(n, 42), 30)
    const rollStart = wrist.clone().addScaledVector(f, -78)
    place(m.forearm, elbow, rollStart, 21)
    place(m.roll, rollStart, wrist.clone().addScaledVector(f, -16), 24)
    place(m.wristHub, wrist.clone().addScaledVector(a5, -30), wrist.clone().addScaledVector(a5, 30), 19)
    const palm = tool.clone().addScaledVector(t, -GRIPPER_LEN)
    place(m.toolLink, wrist, palm, 14)
    place(m.palm, palm.clone().addScaledVector(a5, -42), palm.clone().addScaledVector(a5, 42), 10)
    // Opening grows with the pulse width (assumes more µs = more open)
    const open = 10 + 60 * (Math.min(SERVO_MAX, Math.max(SERVO_MIN, servo)) - SERVO_MIN) / (SERVO_MAX - SERVO_MIN)
    for (const [name, s] of [['fingerA', 1], ['fingerB', -1]] as const) {
      const off = a5.clone().multiplyScalar(s * open / 2)
      place(m[name], palm.clone().add(off), tool.clone().add(off), 5)
    }
  }
}
