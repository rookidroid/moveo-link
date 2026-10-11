// Positions <-> robot commands and kinematics. Pure functions over the
// calibration, so the runner and its tests can use them too.

import { forwardKinematics, inverseKinematics } from '@shared/kinematics'
import type { Calib, Pose, Position, Status } from '@shared/types'

const J = [1, 2, 3, 4, 5]
const isCal = (calib: Calib, i: number) => Math.abs(calib['j' + i]?.spd ?? 0) > 1e-6

const fullyCalibrated = (calib: Calib) => J.every(i => isCal(calib, i))

function limitsOf(calib: Calib) {
  return {
    lo: J.map(i => (calib['j' + i]?.limits ? calib['j' + i].min : -Infinity)),
    hi: J.map(i => (calib['j' + i]?.limits ? calib['j' + i].max : Infinity))
  }
}

/** Speed fraction 0.01..1 from a percentage */
const speedFraction = (pct: number) => Math.min(1, Math.max(0.01, (pct || 100) / 100))

/** REST call that moves the arm to a position */
export function moveCommand(p: Position, speedPct = 100): { path: string; body: Record<string, number> } {
  const speed = speedFraction(speedPct)
  if (p.kind === 'pose' && p.pose) {
    const body: Record<string, number> = { x: p.pose.x, y: p.pose.y, z: p.pose.z, pitch: p.pose.pitch, speed }
    if (p.pose.yaw != null && Number.isFinite(p.pose.yaw)) body.yaw = p.pose.yaw
    return { path: '/movepose', body }
  }
  const j = p.joints!
  const key = j.unit === 'deg' ? 'a' : 'j'
  const body: Record<string, number> = { speed }
  j.v.forEach((v, k) => { body[key + (k + 1)] = j.unit === 'deg' ? v : Math.round(v) })
  return { path: '/movejoints', body }
}

/** Joint angles a position resolves to (pose positions through IK from `seed`) */
export function positionDegrees(p: Position, calib: Calib, seed?: number[] | null): number[] | null {
  if (p.kind === 'joints' && p.joints) {
    if (p.joints.unit === 'deg') return p.joints.v.slice()
    if (!fullyCalibrated(calib)) return null
    return p.joints.v.map((s, k) => calib['j' + (k + 1)].home + s / calib['j' + (k + 1)].spd)
  }
  if (p.kind === 'pose' && p.pose && fullyCalibrated(calib)) {
    const { lo, hi } = limitsOf(calib)
    const r = inverseKinematics(p.pose, seed ?? [0, 0, 0, 0, 0], lo, hi)
    return r.status === 'ok' ? r.deg : null
  }
  return null
}

/** Tool point of a position, for previews */
export function positionToolPoint(p: Position, calib: Calib, seed?: number[] | null): [number, number, number] | null {
  if (p.kind === 'pose' && p.pose) return [p.pose.x, p.pose.y, p.pose.z]
  const deg = positionDegrees(p, calib, seed)
  if (!deg) return null
  const f = forwardKinematics(deg)
  return [f.x, f.y, f.z]
}

/** Problems that stop a position from being reached, empty if none */
export function positionIssues(p: Position, calib: Calib, seed?: number[] | null): string[] {
  const out: string[] = []
  if (p.kind === 'joints') {
    if (!p.joints || p.joints.v.length !== 5 || !p.joints.v.every(Number.isFinite)) return ['invalid joint values']
    if (p.joints.unit === 'deg') {
      p.joints.v.forEach((v, k) => {
        const c = calib['j' + (k + 1)]
        if (!isCal(calib, k + 1)) out.push(`J${k + 1} not calibrated`)
        else if (c.limits && (v < c.min - 1e-3 || v > c.max + 1e-3))
          out.push(`J${k + 1} ${v.toFixed(1)}° outside ${c.min}…${c.max}°`)
      })
    }
  } else {
    const q = p.pose
    if (!q || ![q.x, q.y, q.z, q.pitch].every(Number.isFinite)) return ['invalid pose']
    if (!fullyCalibrated(calib)) return ['tool poses need J1–J5 calibrated']
    const { lo, hi } = limitsOf(calib)
    const r = inverseKinematics(q, seed ?? [0, 0, 0, 0, 0], lo, hi)
    if (r.status === 'unreachable') out.push('pose unreachable')
    if (r.status === 'limits') out.push('pose outside joint limits')
  }
  return out
}

/** Snapshot of the arm from a /status reply */
export function capturePosition(st: Partial<Status>, id: string, name: string): Position {
  const deg = J.map(i => st['a' + i])
  const calibrated = deg.every(v => typeof v === 'number')
  return {
    id, name, kind: 'joints',
    joints: calibrated
      ? { unit: 'deg', v: (deg as number[]).map(v => +v.toFixed(2)) }
      : { unit: 'steps', v: J.map(i => Number(st['j' + i] ?? 0)) },
    pose: calibrated && st.x != null
      ? { x: st.x!, y: st.y!, z: st.z!, pitch: st.pitch!, yaw: st.yaw } : undefined,
    gripper: typeof st.servo === 'number' ? st.servo : null,
    updatedAt: Date.now()
  }
}

export function poseFromDegrees(deg: number[]): Pose {
  const f = forwardKinematics(deg)
  const r = (v: number) => +v.toFixed(1)
  return { x: r(f.x), y: r(f.y), z: r(f.z), pitch: r(f.pitch), yaw: r(f.yaw) }
}

export function describePosition(p: Position): string {
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—')
  if (p.kind === 'pose' && p.pose) {
    const q = p.pose
    return `X ${f(q.x)}  Y ${f(q.y)}  Z ${f(q.z)}  P ${f(q.pitch)}°` + (q.yaw != null ? `  Yaw ${f(q.yaw)}°` : '')
  }
  if (!p.joints) return '—'
  return p.joints.v.map((v, k) => `J${k + 1} ${p.joints!.unit === 'deg' ? f(v) + '°' : Math.round(v)}`).join('  ')
}
