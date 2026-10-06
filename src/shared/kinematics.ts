// Forward / inverse kinematics: a port of the firmware's kinematics.cpp.
// Geometry and joint conventions must match movens_config.h:
//   frame origin on the J1 axis at the base mounting surface, +Z up,
//   +X forward at J1 = 0; all joints 0 = arm pointing straight up.
// Angles in degrees, lengths in mm.

import type { Pose } from './types'

export const KIN = {
  D1: 232.0,  // base -> J2 axis height
  A1: 0.0,    // forward offset of J2 axis from J1 axis
  A2: 221.0,  // J2 axis -> J3 axis
  D4: 223.0,  // J3 axis -> J5 axis, along the forearm
  A3: 0.0,    // forearm axis offset from J3 axis
  D6: 175.0   // J5 axis -> tool point
}

export type Vec3 = [number, number, number]

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (k: number, a: Vec3): Vec3 => [k * a[0], k * a[1], k * a[2]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const EZ: Vec3 = [0, 0, 1]

/* Frame of the forearm for base yaw t1 and forearm pitch phi = J2 + J3 (rad):
     er  horizontal "forward" direction of the arm plane
     n   axis of J2 / J3 / J5 (at J4 = 0); + rotation about it bends forward
     f   forearm direction (elbow -> wrist)
     b   n x f: the direction f moves toward under a + rotation */
interface ArmFrame { er: Vec3; n: Vec3; f: Vec3; b: Vec3 }

function armFrame(t1: number, phi: number): ArmFrame {
  const er: Vec3 = [Math.cos(t1), Math.sin(t1), 0]
  const n: Vec3 = [-Math.sin(t1), Math.cos(t1), 0]
  return {
    er, n,
    f: add(mul(Math.sin(phi), er), mul(Math.cos(phi), EZ)),
    b: sub(mul(Math.cos(phi), er), mul(Math.sin(phi), EZ))
  }
}

/** Key points and joint axes of the arm, for drawing and for FK */
export interface ArmFrames {
  base: Vec3
  shoulder: Vec3      // J2 axis point
  elbow: Vec3         // J3 axis point
  wrist: Vec3         // J5 axis point
  tool: Vec3          // tool point (fingertip centre)
  approach: Vec3      // unit tool direction (wrist -> tool)
  axes: Vec3[]        // rotation axis of J1..J5 (unit, + = right-handed)
  pivots: Vec3[]      // a point on each joint axis, for drawing
}

export function jointFrames(deg: number[]): ArmFrames {
  const t1 = deg[0] * D2R, t2 = deg[1] * D2R, t3 = deg[2] * D2R
  const t4 = deg[3] * D2R, t5 = deg[4] * D2R

  const F = armFrame(t1, t2 + t3)
  const shoulder = add(mul(KIN.A1, F.er), mul(KIN.D1, EZ))
  const elbow = add(shoulder, mul(KIN.A2, add(mul(Math.sin(t2), F.er), mul(Math.cos(t2), EZ))))
  const wrist = add(add(elbow, mul(KIN.D4, F.f)), mul(KIN.A3, F.b))
  const bend = add(mul(Math.cos(t4), F.b), mul(Math.sin(t4), F.n))  // where J5 tips the tool
  const t = add(mul(Math.cos(t5), F.f), mul(Math.sin(t5), bend))
  const tool = add(wrist, mul(KIN.D6, t))
  const forearmMid = add(elbow, mul(KIN.D4 * 0.45, F.f))

  return {
    base: [0, 0, 0], shoulder, elbow, wrist, tool, approach: t,
    axes: [EZ, F.n, F.n, F.f, cross(F.f, bend)],
    pivots: [[0, 0, KIN.D1 * 0.35], shoulder, elbow, forearmMid, wrist]
  }
}

export function forwardKinematics(deg: number[]): Pose & { yaw: number } {
  const fr = jointFrames(deg)
  const t = fr.approach
  return {
    x: fr.tool[0], y: fr.tool[1], z: fr.tool[2],
    pitch: Math.atan2(t[2], Math.hypot(t[0], t[1])) * R2D,
    yaw: Math.atan2(t[1], t[0]) * R2D
  }
}

// C remainderf: x - n*y with n = round-half-even(x / y)
function remainder(x: number, y: number): number {
  const q = x / y
  let n = Math.round(q)
  if (Math.abs(q - Math.trunc(q)) === 0.5) n = 2 * Math.round(q / 2)
  return x - n * y
}

// x + k*360 closest to cur that lies within [lo, hi]; NaN if none does
function fitAngle(x: number, cur: number, lo: number, hi: number): number {
  const tol = 1e-3
  const d = remainder(x - cur, 360)
  let best = NaN
  for (let k = -1; k <= 1; k++) {
    const v = cur + d + 360 * k
    if (v < lo - tol || v > hi + tol) continue
    if (Number.isNaN(best) || Math.abs(v - cur) < Math.abs(best - cur)) best = v
  }
  return best
}

export type IkResult =
  | { status: 'ok'; deg: number[] }
  | { status: 'unreachable' }
  | { status: 'limits' }

/**
 * Same solver as the firmware. Without yaw (null / undefined) the approach
 * stays in the arm's vertical plane. `current` seeds the choice among the
 * solutions; lo / hi are joint limits (±Infinity for unlimited joints).
 */
export function inverseKinematics(target: Pose, current: number[],
                                  lo: number[], hi: number[]): IkResult {
  const eps = 1e-4
  const planar = target.yaw == null || !Number.isFinite(target.yaw)

  let yaw = planar ? 0 : (target.yaw as number) * D2R
  if (planar) {
    yaw = (Math.abs(target.x) > eps || Math.abs(target.y) > eps)
      ? Math.atan2(target.y, target.x) : current[0] * D2R
  }
  const p = target.pitch * D2R
  const a: Vec3 = [Math.cos(p) * Math.cos(yaw), Math.cos(p) * Math.sin(yaw), Math.sin(p)]

  const w = sub([target.x, target.y, target.z], mul(KIN.D6, a))
  const r = Math.hypot(w[0], w[1])
  const t1Base = r > eps ? Math.atan2(w[1], w[0]) : current[0] * D2R

  const L = Math.hypot(KIN.D4, KIN.A3)
  const delta = Math.atan2(KIN.A3, KIN.D4)

  let reachable = false
  let bestCost = Infinity
  let best: number[] = []

  for (let back = 0; back < 2; back++) {
    const t1 = t1Base + (back ? Math.PI : 0)
    const rho = w[0] * Math.cos(t1) + w[1] * Math.sin(t1) - KIN.A1
    const h = w[2] - KIN.D1

    let c = (rho * rho + h * h - KIN.A2 * KIN.A2 - L * L) / (2 * KIN.A2 * L)
    if (Math.abs(c) > 1 + eps) continue
    c = Math.max(-1, Math.min(1, c))
    reachable = true

    for (let elbow = 0; elbow < 2; elbow++) {
      const q = elbow ? -Math.acos(c) : Math.acos(c)
      const t3 = q - delta
      const t2 = Math.atan2(rho, h) - Math.atan2(L * Math.sin(q), KIN.A2 + L * Math.cos(q))

      const F = armFrame(t1, t2 + t3)
      const af = dot(a, F.f), ab = dot(a, F.b), an = dot(a, F.n)
      const s = Math.hypot(ab, an)
      const t4 = s > eps ? Math.atan2(an, ab) : current[3] * D2R
      const t5 = Math.atan2(s, af)

      for (let flip = 0; flip < 2; flip++) {
        const cand = [t1 * R2D, t2 * R2D, t3 * R2D,
          (t4 + (flip ? Math.PI : 0)) * R2D, (flip ? -t5 : t5) * R2D]
        const sol: number[] = []
        let cost = 0
        let ok = true
        for (let j = 0; j < 5 && ok; j++) {
          sol[j] = fitAngle(cand[j], current[j], lo[j], hi[j])
          ok = !Number.isNaN(sol[j])
          if (ok) cost += (sol[j] - current[j]) ** 2
        }
        if (!ok || cost >= bestCost) continue
        bestCost = cost
        best = sol
      }
    }
  }

  if (!reachable) return { status: 'unreachable' }
  return Number.isFinite(bestCost) ? { status: 'ok', deg: best } : { status: 'limits' }
}
