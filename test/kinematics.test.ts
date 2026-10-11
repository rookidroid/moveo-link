import { describe, expect, it } from 'vitest'
import { forwardKinematics, inverseKinematics, jointFrames, KIN, nearestReachable, type Vec3 } from '../src/shared/kinematics'

const INF = [Infinity, Infinity, Infinity, Infinity, Infinity]
const NINF = INF.map(v => -v)

describe('forward kinematics', () => {
  it('points straight up with all joints at zero', () => {
    const p = forwardKinematics([0, 0, 0, 0, 0])
    expect(p.x).toBeCloseTo(KIN.A1, 6)
    expect(p.y).toBeCloseTo(0, 6)
    expect(p.z).toBeCloseTo(KIN.D1 + KIN.A2 + KIN.D4 + KIN.D6, 6)
    expect(p.pitch).toBeCloseTo(90, 6)
  })

  it('reaches forward with the shoulder at +90', () => {
    const p = forwardKinematics([0, 90, 0, 0, 0])
    expect(p.x).toBeCloseTo(KIN.A1 + KIN.A2 + KIN.D4 + KIN.D6, 6)
    expect(p.z).toBeCloseTo(KIN.D1, 6)
    expect(p.pitch).toBeCloseTo(0, 6)
    expect(p.yaw).toBeCloseTo(0, 6)
  })

  it('turns counter-clockwise with J1', () => {
    const p = forwardKinematics([90, 90, 0, 0, 0])
    expect(p.x).toBeCloseTo(0, 6)
    expect(p.y).toBeCloseTo(KIN.A2 + KIN.D4 + KIN.D6, 6)
  })

  it('points the tool down with J5 bent to make pitch -90', () => {
    const p = forwardKinematics([0, 90, 0, 0, 90])
    expect(p.pitch).toBeCloseTo(-90, 6)
    expect(p.x).toBeCloseTo(KIN.A2 + KIN.D4, 6)
    expect(p.z).toBeCloseTo(KIN.D1 - KIN.D6, 6)
  })
})

describe('inverse kinematics', () => {
  it('round-trips FK -> IK -> FK for random arm poses', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let n = 0; n < 200; n++) {
      const deg = [rnd() * 300 - 150, rnd() * 160 - 80, rnd() * 220 - 110, rnd() * 300 - 150, rnd() * 200 - 100]
      const p = forwardKinematics(deg)
      const r = inverseKinematics(p, deg, NINF, INF)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') continue
      const q = forwardKinematics(r.deg)
      expect(q.x).toBeCloseTo(p.x, 4)
      expect(q.y).toBeCloseTo(p.y, 4)
      expect(q.z).toBeCloseTo(p.z, 4)
      expect(q.pitch).toBeCloseTo(p.pitch, 4)
    }
  })

  it('picks the solution closest to the current angles', () => {
    const deg = [20, 30, 50, 0, 40]
    const r = inverseKinematics({ ...forwardKinematics(deg), yaw: null }, deg, NINF, INF)
    expect(r.status).toBe('ok')
    if (r.status === 'ok') r.deg.forEach((v, i) => expect(v).toBeCloseTo(deg[i], 3))
  })

  it('reports unreachable poses', () => {
    expect(inverseKinematics({ x: 2000, y: 0, z: 200, pitch: 0 }, [0, 0, 0, 0, 0], NINF, INF).status).toBe('unreachable')
  })

  it('reports poses outside the joint limits', () => {
    const target = forwardKinematics([0, 60, 60, 0, 30])
    const lo = [-170, -10, -10, -180, -110]
    const hi = [170, 10, 10, 180, 110]
    expect(inverseKinematics({ ...target, yaw: null }, [0, 0, 0, 0, 0], lo, hi).status).toBe('limits')
  })
})

describe('nearest reachable pose', () => {
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  it('leaves a reachable pose alone', () => {
    const deg = [20, 30, 50, 0, 40]
    const p = forwardKinematics(deg)
    const r = nearestReachable({ ...p, yaw: null }, deg, NINF, INF)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.clamped).toBe(false)
    expect(r.pos).toEqual([p.x, p.y, p.z])
  })

  it('pulls a pose that is too far onto the edge of reach', () => {
    for (const pitch of [0, -45, 60]) {
      const target = { x: 2000, y: 300, z: 200, pitch, yaw: null }
      const r = nearestReachable(target, [0, 0, 0, 0, 0], NINF, INF)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') continue
      expect(r.clamped).toBe(true)
      const f = jointFrames(r.deg)
      expect(dist(f.tool, r.pos)).toBeLessThan(1e-6)
      expect(forwardKinematics(r.deg).pitch).toBeCloseTo(pitch, 6)
      expect(dist(f.wrist, f.shoulder)).toBeCloseTo(KIN.A2 + KIN.D4 - 0.5, 6)
      // the wrist moved straight toward the shoulder, so no reachable point is closer
      const want = [target.x - KIN.D6 * f.approach[0], target.y - KIN.D6 * f.approach[1], target.z - KIN.D6 * f.approach[2]]
      expect(dist(want, f.shoulder)).toBeCloseTo(dist(want, f.wrist) + dist(f.wrist, f.shoulder), 6)
    }
  })

  it('keeps a given yaw', () => {
    const r = nearestReachable({ x: 900, y: 900, z: 900, pitch: 10, yaw: 30 }, [0, 0, 0, 0, 0], NINF, INF)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const q = forwardKinematics(r.deg)
    expect(q.pitch).toBeCloseTo(10, 6)
    expect(q.yaw).toBeCloseTo(30, 6)
  })

  it('stops at the joint limits, as close to the target as they allow', () => {
    const lo = [-170, -60, -100, -180, -110]
    const hi = [170, 60, 100, 180, 110]
    const start = [0, 30, 60, 0, 0]
    const s = forwardKinematics(start)
    const from: Vec3 = [s.x, s.y, s.z]
    const target = { x: s.x, y: s.y, z: s.z - 300, pitch: s.pitch, yaw: null }
    expect(inverseKinematics(target, start, lo, hi).status).toBe('limits')
    const r = nearestReachable(target, start, lo, hi, from)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.clamped).toBe(true)
    r.deg.forEach((v, i) => { expect(v).toBeGreaterThanOrEqual(lo[i]); expect(v).toBeLessThanOrEqual(hi[i]) })
    expect(r.deg[1]).toBeCloseTo(hi[1] - 0.1, 2)  // on the J2 limit, less the margin
    expect(dist(jointFrames(r.deg).tool, r.pos)).toBeLessThan(1e-6)
    expect(forwardKinematics(r.deg).pitch).toBeCloseTo(s.pitch, 6)
    const goal = [target.x, target.y, target.z]
    expect(dist(r.pos, goal)).toBeLessThan(dist(from, goal) - 50)
  })

  it('gives up without a reachable start', () => {
    const target = forwardKinematics([0, 60, 60, 0, 30])
    const lo = [-170, -10, -10, -180, -110]
    const hi = [170, 10, 10, 180, 110]
    expect(nearestReachable({ ...target, yaw: null }, [0, 0, 0, 0, 0], lo, hi).status).toBe('limits')
  })
})
