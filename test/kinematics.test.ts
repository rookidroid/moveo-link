import { describe, expect, it } from 'vitest'
import { forwardKinematics, inverseKinematics, jointFrames, KIN } from '../src/shared/kinematics'

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

  it('jointFrames tool point matches FK', () => {
    const deg = [12, 34, 56, -20, 40]
    const f = jointFrames(deg)
    const p = forwardKinematics(deg)
    expect(f.tool[0]).toBeCloseTo(p.x, 9)
    expect(f.tool[1]).toBeCloseTo(p.y, 9)
    expect(f.tool[2]).toBeCloseTo(p.z, 9)
    // joint axes are unit vectors
    for (const a of f.axes) expect(Math.hypot(...a)).toBeCloseTo(1, 9)
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
