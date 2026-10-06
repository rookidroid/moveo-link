// Simulated Moveo robot: the same REST API as the ESP32 firmware, with
// steppers that move in real time. Used by the app's simulation mode (when
// no robot is connected) and by the stand-alone mock server (scripts/).

import { forwardKinematics, inverseKinematics } from './kinematics'
import { SERVO_MAX, SERVO_MIN, type JointCal } from './types'

const N = 5

interface Joint {
  pos: number       // current steps (fractional while moving)
  target: number
  speed: number     // configured steps/s
  accel: number
  runSpeed: number  // speed of the move in progress
}

// Plausible calibration: 1/16 microstepping through belt / gear reductions
export const SIM_CALIBRATION: JointCal[] = [
  { spd: 44.44, home: 0, min: 0, max: 180, limits: true },
  { spd: -88.89, home: 0, min: -95, max: 95, limits: true },
  { spd: 71.11, home: 0, min: -140, max: 140, limits: true },
  { spd: 8.89, home: 0, min: -180, max: 180, limits: true },
  { spd: 26.67, home: 0, min: -110, max: 110, limits: true }
]

export interface SimReply { status: number; data: any }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
const isCal = (c: JointCal) => Math.abs(c.spd) > 1e-6
const degToSteps = (c: JointCal, d: number) => Math.round((d - c.home) * c.spd)
const stepsToDeg = (c: JointCal, s: number) => c.home + s / c.spd
const validJoint = (j: unknown) => Number.isInteger(j) && (j as number) >= 1 && (j as number) <= N
const ok = (data: any = { ok: true }): SimReply => ({ status: 200, data })
const err = (status: number, error: string): SimReply => ({ status, data: { error } })

export class SimRobot {
  private joints: Joint[] = Array.from({ length: N }, () =>
    ({ pos: 0, target: 0, speed: 3000, accel: 800, runSpeed: 3000 }))
  private cal: JointCal[]
  private servo = 1500
  private last: number

  constructor(opts: { calibrated?: boolean; now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.last = this.now()
    this.cal = opts.calibrated === false
      ? Array.from({ length: N }, () => ({ spd: 0, home: 0, min: -180, max: 180, limits: false }))
      : SIM_CALIBRATION.map(c => ({ ...c }))
  }

  private now: () => number

  /** One REST call: GET when body is undefined, POST otherwise */
  handle(path: string, body?: any): SimReply {
    this.advance()
    if (body === undefined) {
      if (path === '/status') return ok(this.status())
      if (path === '/calib') return ok(Object.fromEntries(this.cal.map((c, k) => ['j' + (k + 1), { ...c }])))
      if (path === '/config') return ok(Object.fromEntries(this.joints.map((j, k) => ['j' + (k + 1), { speed: j.speed, accel: j.accel }])))
      return err(404, 'not found')
    }
    const fn = (this.post as Record<string, (b: any) => SimReply>)[path]
    return fn ? fn(body ?? {}) : err(404, 'not found')
  }

  // Constant-speed motion, integrated lazily on every request
  private advance() {
    const t = this.now()
    const dt = Math.max(0, t - this.last) / 1000
    this.last = t
    for (const j of this.joints) {
      const d = j.target - j.pos
      const step = j.runSpeed * dt
      j.pos = Math.abs(d) <= step ? j.target : j.pos + Math.sign(d) * step
    }
  }

  private moving(j: Joint) { return Math.round(j.pos) !== j.target }

  private clampSteps(c: JointCal, t: number) {
    if (!isCal(c) || !c.limits) return t
    const a = degToSteps(c, c.min), b = degToSteps(c, c.max)
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), t))
  }

  private moveTo(i: number, target: number, speed = this.joints[i].speed) {
    this.joints[i].target = this.clampSteps(this.cal[i], Math.round(target))
    this.joints[i].runSpeed = Math.max(1, speed)
  }

  // Like the firmware: all joints finish together, optionally slowed by scale
  private moveSync(targets: number[], scale = 1) {
    const times = targets.map((t, i) =>
      Math.abs(this.clampSteps(this.cal[i], t) - this.joints[i].pos) / this.joints[i].speed)
    const tMax = Math.max(...times)
    targets.forEach((t, i) => {
      const k = tMax > 0 && times[i] > 0 ? times[i] / tMax : 1
      this.moveTo(i, t, this.joints[i].speed * k * scale)
    })
  }

  private degrees(useTarget: boolean): number[] | null {
    if (!this.cal.every(isCal)) return null
    return this.joints.map((j, i) =>
      stepsToDeg(this.cal[i], useTarget && this.moving(j) ? j.target : Math.round(j.pos)))
  }

  private status() {
    const s: Record<string, unknown> = {}
    this.joints.forEach((j, k) => {
      const i = k + 1, pos = Math.round(j.pos)
      s['j' + i] = pos
      s['a' + i] = isCal(this.cal[k]) ? +stepsToDeg(this.cal[k], pos).toFixed(2) : null
      s['m' + i] = this.moving(j) ? 1 : 0
    })
    const deg = this.degrees(false)
    const p = deg && forwardKinematics(deg)
    for (const k of ['x', 'y', 'z', 'pitch', 'yaw'] as const) s[k] = p ? +p[k].toFixed(1) : null
    s.servo = this.servo
    return s
  }

  private speedScale(b: any) {
    const s = num(b.speed)
    return Number.isFinite(s) && s > 0 ? Math.min(1, Math.max(0.01, s)) : 1
  }

  private post = {
    '/stop': () => {
      for (const j of this.joints) { j.target = Math.round(j.pos); j.pos = j.target }
      return ok()
    },
    '/home': () => { this.joints.forEach((_, i) => this.moveTo(i, 0)); return ok() },
    '/move': (b: any) => {
      if (!validJoint(b.joint)) return err(404, 'joint not found')
      const j = this.joints[b.joint - 1]
      this.moveTo(b.joint - 1, (this.moving(j) ? j.target : Math.round(j.pos)) + (b.steps | 0))
      return ok()
    },
    '/moveto': (b: any) => {
      if (!validJoint(b.joint)) return err(404, 'joint not found')
      this.moveTo(b.joint - 1, b.pos | 0)
      return ok()
    },
    '/config': (b: any) => {
      if (!validJoint(b.joint)) return err(404, 'joint not found')
      const j = this.joints[b.joint - 1]
      if (b.speed > 0) j.speed = b.speed | 0
      if (b.accel > 0) j.accel = b.accel | 0
      return ok()
    },
    '/servo': (b: any) => { this.servo = Math.max(SERVO_MIN, Math.min(SERVO_MAX, b.us | 0)); return ok() },
    '/calib': (b: any) => {
      if (!validJoint(b.joint)) return err(404, 'joint not found')
      const c = this.cal[b.joint - 1]
      if (Number.isFinite(b.spd)) c.spd = b.spd
      if (Number.isFinite(b.home)) c.home = b.home
      if (Number.isFinite(b.min)) c.min = b.min
      if (Number.isFinite(b.max)) c.max = b.max
      if (Number.isFinite(b.limits)) c.limits = b.limits !== 0
      if (c.min > c.max) [c.min, c.max] = [c.max, c.min]
      return ok()
    },
    '/moveangle': (b: any) => {
      if (!validJoint(b.joint)) return err(404, 'joint not found')
      if (!Number.isFinite(b.deg)) return err(400, 'missing deg')
      const c = this.cal[b.joint - 1]
      if (!isCal(c)) return err(409, 'joint not calibrated')
      this.moveTo(b.joint - 1, degToSteps(c, b.deg))
      return ok()
    },
    '/setpos': (b: any) => {
      if (!validJoint(b.joint)) return err(404, 'joint not found')
      if (!Number.isFinite(b.deg)) return err(400, 'missing deg')
      const j = this.joints[b.joint - 1], c = this.cal[b.joint - 1]
      if (this.moving(j)) return err(409, 'joint is moving')
      if (!isCal(c) && Math.abs(b.deg - c.home) > 1e-3) return err(409, 'joint not calibrated')
      j.pos = j.target = isCal(c) ? degToSteps(c, b.deg) : 0
      return ok()
    },
    '/movejoints': (b: any) => {
      const targets = this.joints.map(j => (this.moving(j) ? j.target : Math.round(j.pos)))
      let given = 0
      for (let i = 1; i <= N; i++) {
        const d = num(b['a' + i]), s = num(b['j' + i])
        if (Number.isFinite(d)) {
          if (!isCal(this.cal[i - 1])) return err(409, `joint ${i} not calibrated`)
          targets[i - 1] = degToSteps(this.cal[i - 1], d)
          given++
        } else if (Number.isFinite(s)) {
          targets[i - 1] = Math.round(s)
          given++
        }
      }
      if (!given) return err(400, 'no joint targets')
      this.moveSync(targets, this.speedScale(b))
      return ok()
    },
    '/movepose': (b: any) => {
      const cur = this.degrees(true)
      if (!cur) return err(409, `joint ${this.cal.findIndex(c => !isCal(c)) + 1} not calibrated`)
      const t = { x: num(b.x), y: num(b.y), z: num(b.z), pitch: num(b.pitch), yaw: num(b.yaw) }
      const planar = !Number.isFinite(t.yaw)
      if (b.rel > 0) {
        const base = forwardKinematics(cur)
        t.x = base.x + (Number.isFinite(t.x) ? t.x : 0)
        t.y = base.y + (Number.isFinite(t.y) ? t.y : 0)
        t.z = base.z + (Number.isFinite(t.z) ? t.z : 0)
        t.pitch = base.pitch + (Number.isFinite(t.pitch) ? t.pitch : 0)
        if (!planar) t.yaw += base.yaw
      }
      if (![t.x, t.y, t.z, t.pitch].every(Number.isFinite)) return err(400, 'x, y, z and pitch are required')
      const lo = this.cal.map(c => (c.limits ? c.min : -Infinity))
      const hi = this.cal.map(c => (c.limits ? c.max : Infinity))
      const r = inverseKinematics({ ...t, yaw: planar ? null : t.yaw }, cur, lo, hi)
      if (r.status === 'unreachable') return err(422, 'pose unreachable')
      if (r.status === 'limits') return err(422, 'pose outside joint limits')
      if (!(b.dry > 0)) this.moveSync(r.deg.map((d, i) => degToSteps(this.cal[i], d)), this.speedScale(b))
      return ok({ ok: true, deg: r.deg.map(d => +d.toFixed(2)) })
    }
  }
}
