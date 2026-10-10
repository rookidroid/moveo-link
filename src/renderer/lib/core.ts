// Shared renderer plumbing, ported from the firmware's app.js: helpers,
// robot API calls with toasts, connection state, E-stop, widgets and the
// adaptive /status polling, plus a tiny event bus that feeds every view.

import { SimRobot } from '@shared/simRobot'
import type { ApiResult, Calib, JointCal, MovensBridge, Status } from '@shared/types'

declare global {
  interface Window { movens: MovensBridge }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
export const JOINT_NAMES = ['Base', 'Shoulder', 'Elbow', 'Wrist roll', 'Wrist pitch']
export const N = JOINT_NAMES.length
export const isCal = (c?: JointCal | null): c is JointCal => !!c && Math.abs(c.spd) > 1e-6

// Signed fixed-point readout: +012.3 style, with a real minus sign
export function fmt(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = Math.abs(v).toFixed(d)
  return (+v.toFixed(d) < 0 ? '−' : '+') + s
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// ── Per-user UI preferences (never robot state) ─────────────────────────────
export function pref<T>(key: string, def: T): T {
  try { const v = localStorage.getItem('movens.' + key); return v == null ? def : JSON.parse(v) }
  catch { return def }
}
export function setPref(key: string, v: unknown) {
  try { localStorage.setItem('movens.' + key, JSON.stringify(v)) } catch { /* storage unavailable */ }
}

// ── Event bus ────────────────────────────────────────────────────────────────
type Events = {
  status: Status
  calib: Calib
  connected: boolean
  estop: void
  library: void
  preview: 'position' | 'step'  // which panel's pick the ghost now shows
  view: string
  host: string
  mode: Mode
}
const listeners: { [K in keyof Events]?: Array<(d: Events[K]) => void> } = {}
export function on<K extends keyof Events>(evt: K, fn: (d: Events[K]) => void) {
  (listeners[evt] ||= [] as any).push(fn)
}
export function emit<K extends keyof Events>(evt: K, data: Events[K]) {
  for (const fn of listeners[evt] || []) fn(data)
}

// ── Shared robot state ───────────────────────────────────────────────────────
/** 'sim': the built-in simulated arm (default); 'robot': the real arm over WiFi */
export type Mode = 'sim' | 'robot'

export const state = {
  status: {} as Partial<Status>,
  calib: {} as Calib,
  connected: true as boolean | null,  // robot mode: last request reached the robot (always true in simulation)
  host: '',
  mode: 'sim' as Mode
}
export const cal = (i: number) => state.calib['j' + i]
export const allCalibrated = () => [1, 2, 3, 4, 5].every(i => isCal(cal(i)))

/** J1..J5 in degrees from a status reply, or null if any joint is uncalibrated */
export function statusDegrees(d: Partial<Status> = state.status): number[] | null {
  const a = [1, 2, 3, 4, 5].map(i => d['a' + i])
  return a.every(v => typeof v === 'number') ? (a as number[]) : null
}

/** Joint limits for IK: ±Infinity where soft limits are off */
export function jointLimits(): { lo: number[]; hi: number[] } {
  const lo: number[] = [], hi: number[] = []
  for (let i = 1; i <= N; i++) {
    const c = cal(i)
    lo.push(c?.limits ? c.min : -Infinity)
    hi.push(c?.limits ? c.max : Infinity)
  }
  return { lo, hi }
}

export function setConnected(ok: boolean) {
  if (ok === state.connected) return
  state.connected = ok
  renderConn()
  emit('connected', ok)
}

// ── Connection: simulation until the user connects ───────────────────────────
const sim = new SimRobot()
let connecting = false

export function renderConn() {
  const robot = state.mode === 'robot'
  $('dot').className = 'led ' + (!robot ? 'sim' : state.connected ? 'ok' : state.connected === false ? 'err' : '')
  $('conn-status').textContent = connecting ? 'Connecting' : !robot ? 'Simulation'
    : state.connected ? 'Online' : state.connected === false ? 'Offline' : 'Connecting'
  $('conn-host').textContent = robot ? state.host : 'virtual arm'
  const b = $<HTMLButtonElement>('btnConn')
  b.textContent = connecting ? 'Connecting…' : robot ? 'Disconnect' : 'Connect'
  b.disabled = connecting
  b.classList.toggle('primary', !robot)
  document.body.classList.toggle('sim-mode', !robot)
}

/** Connect to the robot at `host` (default: the saved address). Stays in
 *  simulation and returns false when the robot does not answer. */
export async function connect(host?: string): Promise<boolean> {
  if (connecting) return false
  if (host) {
    const s = await window.movens.settings.set({ host })
    setHost(s.host)
  }
  if (state.mode === 'robot') await switchMode('sim')
  connecting = true
  renderConn()
  const r = await window.movens.api('/status')
  connecting = false
  if (!r.ok) {
    renderConn()
    showToast(`Can't reach ${state.host}: ${r.error}`, 'err')
    return false
  }
  await switchMode('robot')
  showToast(`Connected to ${state.host}`)
  return true
}

export async function disconnect() {
  if (state.mode !== 'robot') return
  await switchMode('sim')
  showToast('Disconnected · simulation mode')
}

export function setHost(host: string) {
  state.host = host
  renderConn()
  emit('host', host)
}

async function switchMode(m: Mode) {
  emit('estop', undefined)           // stop sequences and live mouse control
  const stop = request('/stop', {})  // and the arm we were driving
  if (state.connected !== false) await stop  // don't wait out the timeout of an unreachable robot
  state.mode = m
  state.status = {}
  state.calib = {}
  state.connected = m === 'sim' ? true : null
  calibPending = true
  anyMoving = false
  renderConn()
  emit('mode', m)
  schedulePoll(0)
}

// ── API ──────────────────────────────────────────────────────────────────────
/** Raw request to the simulation or the robot, no toast. */
export async function request<T = any>(path: string, body?: unknown): Promise<ApiResult<T>> {
  if (state.mode === 'sim') {
    const r = sim.handle(path, body === undefined ? undefined : structuredClone(body))
    await Promise.resolve()
    return r.status < 400
      ? { ok: true, status: r.status, data: r.data }
      : { ok: false, status: r.status, data: r.data, error: r.data?.error || `HTTP ${r.status}` }
  }
  const r = await window.movens.api(path, body)
  if (state.mode === 'robot') setConnected(r.status !== 0)  // still connected to the same target
  return r
}

/** GET without body, POST JSON with one. Returns the reply, or null after
 *  showing the error (also kept in api.lastError). Commands speed up polling. */
export async function api<T = any>(path: string, body?: unknown): Promise<T | null> {
  const r = await request<T>(path, body)
  if (!r.ok) {
    api.lastError = r.error || 'Request failed'
    showToast(api.lastError, 'err')
    return null
  }
  if (body !== undefined) kick()
  return r.data as T
}
api.lastError = ''

export function showToast(msg: string, type: 'ok' | 'err' = 'ok') {
  const t = $('toast') as HTMLElement & { _timer?: number }
  t.textContent = msg
  t.className = 'toast show ' + type
  clearTimeout(t._timer)
  t._timer = window.setTimeout(() => (t.className = 'toast'), 2800)
}

// ── E-stop: button in the app bar, or Esc anywhere ──────────────────────────
export async function stopAll() {
  const b = $('btnStop')
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash')
  emit('estop', undefined)
  if (await api('/stop', {})) showToast('All motors stopped', 'err')
}

// ── Widgets ──────────────────────────────────────────────────────────────────
export interface Seg<T> { value: T; set(opts: Array<T | [T, string]>, v: T): void }

/** Segmented control. opts: values or [value, label] pairs. onChange fires on clicks. */
export function seg<T>(el: HTMLElement, opts: Array<T | [T, string]>, value: T,
                       onChange?: (v: T) => void): Seg<T> {
  let pairs: Array<[T, string]> = []
  const s: Seg<T> = {
    value,
    set(o, v) {
      pairs = o.map(x => (Array.isArray(x) ? x : [x, String(x)]))
      s.value = pairs.some(([x]) => x === v) ? v : pairs[0][0]
      el.innerHTML = pairs.map(([x, l], i) =>
        `<button type="button" role="radio" data-i="${i}" aria-checked="${x === s.value}">${l}</button>`).join('')
    }
  }
  el.classList.add('seg')
  el.setAttribute('role', 'radiogroup')
  el.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b || !el.contains(b)) return
    s.value = pairs[+b.dataset.i!][0]
    el.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)))
    onChange?.(s.value)
  })
  s.set(opts, value)
  return s
}

/** Two-tap confirmation: the first tap arms the button for 3 s, the second runs fn */
export function confirmTap(btn: HTMLElement, fn: () => void, prompt = 'Tap again to confirm') {
  const label = btn.innerHTML
  let t = 0
  const reset = () => { delete btn.dataset.armed; btn.classList.remove('armed'); btn.innerHTML = label }
  btn.addEventListener('click', () => {
    clearTimeout(t)
    if (btn.dataset.armed) { reset(); fn(); return }
    btn.dataset.armed = '1'
    btn.classList.add('armed')
    btn.textContent = prompt
    t = window.setTimeout(reset, 3000)
  })
}

// ── Calibration (shared by every view) ──────────────────────────────────────
export async function loadCalib(): Promise<boolean> {
  const r = await api<Calib>('/calib')
  if (!r) return false
  state.calib = r
  emit('calib', r)
  return true
}

// ── Adaptive status polling ──────────────────────────────────────────────────
// Fast while a joint moves or right after a command, slow when idle, paused
// while the window is hidden. Sequential, so requests never pile up.
const POLL_FAST = 400, POLL_IDLE = 1500, BOOST_MS = 3000
let polling = false, pollTimer = 0, boostUntil = 0, anyMoving = false
let calibPending = true  // (re)load /calib once the robot answers

function schedulePoll(ms: number) { clearTimeout(pollTimer); pollTimer = window.setTimeout(pollStatus, ms) }
export function kick() { boostUntil = Date.now() + BOOST_MS; if (!polling) schedulePoll(120) }

/** Publish a /status reply fetched elsewhere (e.g. by the sequence runner) */
export function publishStatus(d: Status) {
  state.status = d
  anyMoving = [1, 2, 3, 4, 5].some(i => d['m' + i])
  emit('status', d)
}

async function pollStatus() {
  if (polling || document.hidden) return
  polling = true
  let ok = false
  const mode = state.mode
  try {
    const r = await request<Status>('/status')
    if (mode !== state.mode) return  // switched while waiting: drop the stale reply
    ok = r.ok
    if (ok) {
      publishStatus(r.data!)
      if (calibPending) calibPending = !(await loadCalib())
    } else {
      calibPending = true
    }
  } finally {
    polling = false
    schedulePoll(mode !== state.mode ? 0 : ok && (anyMoving || Date.now() < boostUntil) ? POLL_FAST : POLL_IDLE)
  }
}

export function startPolling() {
  renderConn()
  emit('mode', state.mode)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0) })
  pollStatus()
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
