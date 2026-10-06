import { describe, expect, it } from 'vitest'
import type { ApiResult, Position, Sequence, Step } from '../src/shared/types'
import { Runner, STEP_TIMEOUT_MS } from '../src/renderer/lib/runner'

/** Fake robot on a virtual clock: every move takes `moveMs` */
function fakeRobot(opts: { moveMs?: number; fail?: Record<string, ApiResult>; stuck?: boolean } = {}) {
  let t = 0
  let busyUntil = 0
  const calls: Array<{ t: number; path: string; body?: any }> = []
  const api = async (path: string, body?: unknown): Promise<ApiResult> => {
    if (path !== '/status') calls.push({ t, path, body })
    if (opts.fail?.[path]) return opts.fail[path]
    if (path === '/movejoints' || path === '/movepose') busyUntil = t + (opts.moveMs ?? 1000)
    if (path === '/stop') busyUntil = t
    if (path === '/status') {
      const m = opts.stuck || t < busyUntil ? 1 : 0
      return { ok: true, status: 200, data: { m1: m, m2: 0, m3: 0, m4: 0, m5: 0, servo: 1500 } }
    }
    return { ok: true, status: 200, data: { ok: true } }
  }
  return {
    calls,
    deps: {
      api,
      sleep: async (ms: number) => { t += ms; await new Promise(res => setImmediate(res)) },
      now: () => t
    },
    time: () => t
  }
}

const P: Record<string, Position> = {
  a: { id: 'a', name: 'A', kind: 'joints', joints: { unit: 'deg', v: [0, 10, 20, 0, 30] }, gripper: null, updatedAt: 0 },
  b: { id: 'b', name: 'B', kind: 'pose', pose: { x: 300, y: 0, z: 200, pitch: -90, yaw: null }, gripper: 2000, updatedAt: 0 }
}
const position = (id: string) => P[id]
const seq = (steps: Step[], repeat = 1): Sequence => ({ id: 's', name: 'S', repeat, steps, updatedAt: 0 })
const move = (positionId: string, speed = 50, dwellMs = 0): Step => ({ id: positionId, type: 'move', positionId, speed, dwellMs })

describe('Runner', () => {
  it('runs steps in order and waits for each move to finish', async () => {
    const r = fakeRobot({ moveMs: 2000 })
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('a', 40), { id: 'w', type: 'wait', ms: 500 }, move('b', 100)]))
    expect(runner.info.state).toBe('idle')
    expect(r.calls.map(c => c.path)).toEqual(['/movejoints', '/movepose', '/servo'])
    expect(r.calls[0].body).toMatchObject({ a1: 0, a2: 10, a3: 20, a4: 0, a5: 30, speed: 0.4 })
    expect(r.calls[1].body).toMatchObject({ x: 300, y: 0, z: 200, pitch: -90, speed: 1 })
    expect(r.calls[1].body.yaw).toBeUndefined()
    // second move only after the first one finished plus the wait
    expect(r.calls[1].t).toBeGreaterThanOrEqual(2000 + 500)
    // gripper of position B applied after its move finished
    expect(r.calls[2]).toMatchObject({ path: '/servo', body: { us: 2000 } })
    expect(r.calls[2].t).toBeGreaterThanOrEqual(r.calls[1].t + 2000)
  })

  it('repeats the sequence', async () => {
    const r = fakeRobot({ moveMs: 100 })
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('a')], 3))
    expect(r.calls.filter(c => c.path === '/movejoints')).toHaveLength(3)
  })

  it('does not hang on zero-length moves', async () => {
    const r = fakeRobot({ moveMs: 0 })
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('a'), move('a')]))
    expect(runner.info.state).toBe('idle')
    expect(r.calls).toHaveLength(2)
  })

  it('runs a single step from the given index', async () => {
    const r = fakeRobot()
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('a'), { id: 'g', type: 'gripper', us: 900, settleMs: 100 }, move('b')]), { from: 1, single: true })
    expect(r.calls.map(c => c.path)).toEqual(['/servo'])
    expect(runner.info.index).toBe(2)
  })

  it('aborts with an error and stops the arm when a move is rejected', async () => {
    const r = fakeRobot({ fail: { '/movepose': { ok: false, status: 422, error: 'pose unreachable' } } })
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('a'), move('b'), move('a')]))
    expect(runner.info.state).toBe('error')
    expect(runner.info.message).toBe('Step 2: pose unreachable')
    expect(r.calls.map(c => c.path)).toEqual(['/movejoints', '/movepose', '/stop'])
  })

  it('fails when a position is missing', async () => {
    const r = fakeRobot()
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('zzz')]))
    expect(runner.info.state).toBe('error')
    expect(runner.info.message).toMatch(/missing/)
  })

  it('times out when the arm never settles', async () => {
    const r = fakeRobot({ stuck: true })
    const runner = new Runner({ ...r.deps, position })
    await runner.run(seq([move('a')]))
    expect(runner.info.state).toBe('error')
    expect(runner.info.message).toMatch(/timed out/)
    expect(r.time()).toBeGreaterThan(STEP_TIMEOUT_MS)
  })

  it('stops on request and sends /stop', async () => {
    const r = fakeRobot({ moveMs: 5000 })
    const runner = new Runner({ ...r.deps, position })
    const done = runner.run(seq([move('a'), move('b')]))
    while (r.time() < 1000) await new Promise(res => setImmediate(res))  // mid-move
    await runner.stop()
    await done
    expect(runner.info.state).toBe('idle')
    expect(runner.info.message).toBe('Stopped')
    expect(r.calls.map(c => c.path)).toEqual(['/movejoints', '/stop'])
  })

  it('pauses after the current step and resumes', async () => {
    const r = fakeRobot({ moveMs: 1000 })
    const runner = new Runner({ ...r.deps, position })
    const states: string[] = []
    runner.onUpdate(i => states.push(i.state))
    const done = runner.run(seq([move('a'), move('a'), move('a')]))
    runner.pause()
    // let it reach the pause point
    for (let i = 0; i < 50 && runner.info.state !== 'paused'; i++) await new Promise(res => setTimeout(res, 0))
    expect(runner.info.state).toBe('paused')
    expect(runner.info.index).toBe(1)
    expect(r.calls.filter(c => c.path === '/movejoints')).toHaveLength(1)
    runner.resume()
    await done
    expect(r.calls.filter(c => c.path === '/movejoints')).toHaveLength(3)
    expect(states).toContain('paused')
    expect(runner.info.state).toBe('idle')
  })
})
