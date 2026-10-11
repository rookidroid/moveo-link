// Sequence player. Sends one step at a time and waits for the arm to settle
// (all mN flags in /status back to 0) before the next one.

import type { ApiResult, Position, Sequence, Status, Step } from '@shared/types'
import { moveCommand } from './motion'

export interface RunnerDeps {
  api(path: string, body?: unknown): Promise<ApiResult>
  position(id: string): Position | undefined
  onStatus?(s: Status): void
  sleep?(ms: number): Promise<void>
  now?(): number
}

type RunState = 'idle' | 'running' | 'paused' | 'error'

export interface RunInfo {
  state: RunState
  index: number        // step being executed (or next, when paused)
  loop: number         // 1-based
  loops: number        // 0 = endless
  message: string
}

const POLL_MS = 150
const START_GRACE_MS = 600   // a zero-length move never reports motion
export const STEP_TIMEOUT_MS = 120000
const GRIPPER_SETTLE_MS = 500

class Aborted extends Error {}

export class Runner {
  info: RunInfo = { state: 'idle', index: 0, loop: 1, loops: 1, message: '' }
  private abort = false
  private pauseReq = false
  private resumeFn: (() => void) | null = null
  private listeners: Array<(i: RunInfo) => void> = []
  private sleep: (ms: number) => Promise<void>
  private now: () => number

  constructor(private deps: RunnerDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.now = deps.now ?? (() => Date.now())
  }

  onUpdate(fn: (i: RunInfo) => void) { this.listeners.push(fn) }
  private update(patch: Partial<RunInfo>) {
    Object.assign(this.info, patch)
    for (const fn of this.listeners) fn({ ...this.info })
  }

  get busy() { return this.info.state === 'running' || this.info.state === 'paused' }

  /**
   * Play `seq` from step `from`. With single, run that one step only.
   * Resolves when finished, stopped or failed (see info.state / message).
   */
  async run(seq: Sequence, opts: { from?: number; single?: boolean } = {}): Promise<void> {
    if (this.busy || !seq.steps.length) return
    const steps = structuredClone(seq.steps)
    const loops = opts.single ? 1 : Math.max(0, Math.floor(seq.repeat))
    this.abort = false
    this.pauseReq = false
    this.update({ state: 'running', index: opts.from ?? 0, loop: 1, loops, message: '' })
    try {
      for (let loop = 1; loops === 0 || loop <= loops; loop++) {
        const first = loop === 1 ? (opts.from ?? 0) : 0
        for (let i = first; i < steps.length; i++) {
          await this.checkpoint(i, loop)
          this.update({ state: 'running', index: i, loop, message: describeStep(steps[i], this.deps.position) })
          await this.exec(steps[i], i)
          if (opts.single) {
            this.update({ state: 'idle', index: Math.min(i + 1, steps.length - 1), message: 'Step done' })
            return
          }
        }
      }
      this.update({ state: 'idle', message: 'Sequence finished' })
    } catch (e) {
      if (e instanceof Aborted) {
        this.update({ state: 'idle', message: 'Stopped' })
      } else {
        await this.deps.api('/stop', {})
        this.update({ state: 'error', message: (e as Error).message })
      }
    }
  }

  /** Pause after the current step */
  pause() { if (this.info.state === 'running') { this.pauseReq = true; this.update({ message: 'Pausing after this step…' }) } }

  resume() {
    this.pauseReq = false
    if (this.info.state === 'paused') { this.update({ state: 'running' }); this.resumeFn?.() }
  }

  /** Abort the run and stop the motors */
  async stop() {
    if (!this.busy) return
    this.abort = true
    this.resumeFn?.()
    await this.deps.api('/stop', {})
  }

  private async checkpoint(index: number, loop: number) {
    if (this.abort) throw new Aborted()
    if (this.pauseReq) {
      this.update({ state: 'paused', index, loop, message: 'Paused' })
      await new Promise<void>(r => (this.resumeFn = r))
      this.resumeFn = null
      if (this.abort) throw new Aborted()
    }
  }

  private async wait(ms: number) {
    const end = this.now() + ms
    while (this.now() < end) {
      if (this.abort) throw new Aborted()
      await this.sleep(Math.min(100, end - this.now()))
    }
    if (this.abort) throw new Aborted()
  }

  private async call(path: string, body: unknown, stepNo: number) {
    const r = await this.deps.api(path, body)
    if (this.abort) throw new Aborted()
    if (!r.ok) throw new Error(`Step ${stepNo + 1}: ${r.error || 'request failed'}`)
    return r
  }

  private async exec(step: Step, i: number) {
    switch (step.type) {
      case 'move': {
        const p = this.deps.position(step.positionId)
        if (!p) throw new Error(`Step ${i + 1}: position is missing`)
        const cmd = moveCommand(p, step.speed)
        await this.call(cmd.path, cmd.body, i)
        await this.waitIdle(i)
        if (p.gripper != null) {
          await this.call('/servo', { us: p.gripper }, i)
          await this.wait(GRIPPER_SETTLE_MS)
        }
        if (step.dwellMs > 0) await this.wait(step.dwellMs)
        break
      }
      case 'gripper':
        await this.call('/servo', { us: step.us }, i)
        await this.wait(Math.max(0, step.settleMs))
        break
      case 'wait':
        await this.wait(Math.max(0, step.ms))
        break
    }
  }

  /** Poll /status until every joint has stopped */
  private async waitIdle(i: number) {
    const t0 = this.now()
    let seenMoving = false
    for (;;) {
      await this.sleep(POLL_MS)
      if (this.abort) throw new Aborted()
      const r = await this.deps.api('/status')
      if (this.abort) throw new Aborted()
      if (!r.ok) throw new Error(`Step ${i + 1}: ${r.status === 0 ? 'connection lost' : r.error}`)
      const st = r.data as Status
      this.deps.onStatus?.(st)
      const moving = [1, 2, 3, 4, 5].some(j => st['m' + j])
      if (moving) seenMoving = true
      const elapsed = this.now() - t0
      if (!moving && (seenMoving || elapsed >= START_GRACE_MS)) return
      if (elapsed > STEP_TIMEOUT_MS) throw new Error(`Step ${i + 1}: timed out waiting for the arm`)
    }
  }
}

function describeStep(s: Step, position: (id: string) => Position | undefined): string {
  switch (s.type) {
    case 'move': return `Move to ${position(s.positionId)?.name ?? '(missing position)'} at ${s.speed}%`
    case 'gripper': return `Gripper → ${s.us} µs`
    case 'wait': return `Wait ${(s.ms / 1000).toFixed(1)} s`
  }
}
