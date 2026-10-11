import { describe, expect, it } from 'vitest'
import { KIN } from '../src/shared/kinematics'
import { SimRobot } from '../src/shared/simRobot'

function sim(calibrated = true) {
  let t = 0
  return { robot: new SimRobot({ calibrated, now: () => t }), advance: (ms: number) => { t += ms } }
}

describe('SimRobot', () => {
  it('starts at the zero pose, calibrated', () => {
    const { robot } = sim()
    const s = robot.handle('/status').data
    expect([s.a1, s.a2, s.a3, s.a4, s.a5]).toEqual([0, 0, 0, 0, 0])
    expect(s.z).toBeCloseTo(KIN.D1 + KIN.A2 + KIN.D4 + KIN.D6, 0)  // straight up
  })

  it('moves joints in sync over time and reports motion', () => {
    const { robot, advance } = sim()
    expect(robot.handle('/movejoints', { a1: 30, a2: 15, speed: 0.5 }).status).toBe(200)
    advance(500)
    const mid = robot.handle('/status').data
    expect(mid.m1).toBe(1)
    expect(mid.a1 / 30).toBeCloseTo(mid.a2 / 15, 1)   // same fraction done
    advance(60000)
    const end = robot.handle('/status').data
    expect([end.m1, end.m2]).toEqual([0, 0])
    expect(end.a1).toBeCloseTo(30, 1)
    expect(end.a2).toBeCloseTo(15, 1)
  })

  it('solves poses and rejects unreachable ones', () => {
    const { robot, advance } = sim()
    const r = robot.handle('/movepose', { x: 300, y: 0, z: 200, pitch: -90 })
    expect(r.status).toBe(200)
    advance(60000)
    const s = robot.handle('/status').data
    expect([s.x, s.y, s.z, s.pitch]).toEqual([expect.closeTo(300, 0), 0, expect.closeTo(200, 0), -90])
    expect(robot.handle('/movepose', { x: 3000, y: 0, z: 200, pitch: 0 }).status).toBe(422)
  })

  it('clamps to soft limits and stops on /stop', () => {
    const { robot, advance } = sim()
    robot.handle('/movejoints', { a2: 500 })
    advance(1000)
    robot.handle('/stop', {})
    const stopped = robot.handle('/status').data
    advance(5000)
    expect(robot.handle('/status').data.a2).toBe(stopped.a2)
    robot.handle('/movejoints', { a2: 500 })
    advance(120000)
    expect(robot.handle('/status').data.a2).toBeCloseTo(95, 0)   // J2 max
  })

  it('needs calibration for angles when uncalibrated', () => {
    const { robot } = sim(false)
    expect(robot.handle('/movejoints', { a1: 10 }).status).toBe(409)
    expect(robot.handle('/movejoints', { j1: 100 }).status).toBe(200)
  })
})
