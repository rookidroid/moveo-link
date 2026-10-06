// Control view: port of the firmware's control page (web_index_html.h),
// plus the 3D view and "Save position".

import { uid, type MotionConfig, type Status } from '@shared/types'
import { armView } from '../lib/arm3d'
import {
  $, api, cal, confirmTap, fmt, isCal, JOINT_NAMES, N, on, pref, seg, setPref, showToast, state
} from '../lib/core'
import { promptText } from '../lib/dialog'
import { changed, lib, nextName } from '../lib/library'
import { capturePosition } from '../lib/motion'

let CFG: MotionConfig = {}
let lastPose: Status | null = null

// Position of angle a on the joint's min..max scale, in %
const pct = (c: { min: number; max: number }, a: number) => (a - c.min) / (c.max - c.min) * 100

export function initControl() {
  // ── Arm state ───────────────────────────────────────────────────────────────
  $('jlist').innerHTML = JOINT_NAMES.map((n, k) => { const i = k + 1; return `
    <div class="jrow">
      <span class="led" id="led-${i}"></span><span class="jtag">J${i}</span><span class="jname">${n}</span>
      <span class="jang" id="ang-${i}">—</span><span class="jstp" id="stp-${i}">—</span>
      <div class="meter" id="mtr-${i}"></div>
    </div>` }).join('')

  // ── Joints tab ──────────────────────────────────────────────────────────────
  const STEP_OPTS: Record<string, number[]> = { deg: [0.5, 1, 5, 10, 45], steps: [1, 10, 100, 1000] }
  const jStep: Record<string, number> = { deg: pref('stepDeg', 5), steps: pref('stepSteps', 100) }
  let unit: 'deg' | 'steps' = pref('unit', 'deg')

  seg<'deg' | 'steps'>($('seg-unit'), [['deg', 'DEG'], ['steps', 'STEPS']], unit, v => {
    unit = v; setPref('unit', v)
    segJStep.set(STEP_OPTS[v], jStep[v])
    renderJointCtl()
  })
  const segJStep = seg($('seg-jstep'), STEP_OPTS[unit], jStep[unit], v => {
    jStep[unit] = v; setPref(unit === 'deg' ? 'stepDeg' : 'stepSteps', v)
  })

  // 'deg', 'steps', or null when degrees are selected but the joint is uncalibrated
  const jointUnit = (i: number) => unit === 'steps' ? 'steps' : (isCal(cal(i)) ? 'deg' : null)

  $('jctl').innerHTML = JOINT_NAMES.map((n, k) => { const i = k + 1; return `
    <div class="jc" id="jc-${i}">
      <div class="jc-id">
        <div class="top"><span class="jtag">J${i}</span><span class="jname">${n}</span></div>
        <span class="jc-v" id="jcv-${i}">—</span>
      </div>
      <button class="btn jog" data-jog="${i},-1" aria-label="Jog J${i} negative">&minus;</button>
      <button class="btn jog" data-jog="${i},1" aria-label="Jog J${i} positive">+</button>
      <span class="inp"><input type="number" step="any" id="tgt-${i}" data-i="${i}" aria-label="J${i} target"/><i id="tu-${i}">&deg;</i></span>
      <button class="btn" data-go="${i}">Go</button>
    </div>` }).join('')

  function renderJointCtl() {
    for (let i = 1; i <= N; i++) {
      const u = jointUnit(i), row = $('jc-' + i)
      row.classList.toggle('nocal', !u)
      row.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(e => (e.disabled = !u))
      $('tu-' + i).textContent = u === 'steps' ? 'st' : '°'
      $<HTMLInputElement>('tgt-' + i).placeholder = u ? 'target' : ''
    }
    renderJointValues()
  }

  function renderJointValues() {
    const ST = state.status
    for (let i = 1; i <= N; i++) {
      const u = jointUnit(i)
      $('jcv-' + i).textContent =
        !u ? 'Not calibrated — use steps' :
        u === 'deg' ? fmt(ST['a' + i] as number) + '°' : (ST['j' + i] ?? '—') + ' st'
    }
  }

  async function jointJog(i: number, dir: number) {
    const u = jointUnit(i), step = segJStep.value
    const steps = (u === 'deg' ? Math.round(step * cal(i).spd) : step) * dir
    if (!steps) return showToast(`Step too small for J${i}`, 'err')
    await api('/move', { joint: i, steps })
  }

  async function jointGo(i: number) {
    const u = jointUnit(i), v = parseFloat($<HTMLInputElement>('tgt-' + i).value)
    if (!Number.isFinite(v)) return showToast(`Enter a J${i} target`, 'err')
    const r = u === 'deg'
      ? await api('/moveangle', { joint: i, deg: v })
      : await api('/moveto', { joint: i, pos: Math.round(v) })
    if (r) showToast(`J${i} → ` + (u === 'deg' ? fmt(v) + '°' : Math.round(v) + ' st'))
  }

  $('jctl').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b) return
    if (b.dataset.jog) { const [i, d] = b.dataset.jog.split(',').map(Number); jointJog(i, d) }
    if (b.dataset.go) jointGo(+b.dataset.go)
  })
  $('jctl').addEventListener('keydown', e => {
    const t = e.target as HTMLInputElement
    if (e.key === 'Enter' && t.dataset.i) jointGo(+t.dataset.i)
  })

  // ── Motion settings ─────────────────────────────────────────────────────────
  $('cfg-body').innerHTML = JOINT_NAMES.map((n, k) => { const i = k + 1; return `
    <tr><td>J${i} <span class="muted">${n}</span></td>
      <td><input type="number" min="1" id="spd-${i}" data-i="${i}"/></td>
      <td><input type="number" min="1" id="acc-${i}" data-i="${i}"/></td></tr>` }).join('')
  $('cfg-body').addEventListener('input', e => markCfg(+(e.target as HTMLElement).dataset.i!))

  async function loadConfig() {
    const r = await api<MotionConfig>('/config')
    if (!r) return
    CFG = r
    for (let i = 1; i <= N; i++) {
      const c = CFG['j' + i]
      if (!c) continue
      $<HTMLInputElement>('spd-' + i).value = String(c.speed)
      $<HTMLInputElement>('acc-' + i).value = String(c.accel)
      markCfg(i)
    }
  }

  // [speed changed, accel changed]
  function cfgChanged(i: number) {
    const c = CFG['j' + i] || {} as any
    return [parseInt($<HTMLInputElement>('spd-' + i).value) !== c.speed,
            parseInt($<HTMLInputElement>('acc-' + i).value) !== c.accel]
  }
  function markCfg(i: number) {
    const [s, a] = cfgChanged(i)
    $('spd-' + i).classList.toggle('dirty', s)
    $('acc-' + i).classList.toggle('dirty', a)
  }

  async function applyConfig() {
    let n = 0
    for (let i = 1; i <= N; i++) {
      if (!cfgChanged(i).some(Boolean)) continue
      const speed = parseInt($<HTMLInputElement>('spd-' + i).value), accel = parseInt($<HTMLInputElement>('acc-' + i).value)
      if (!(speed > 0 && accel > 0)) return showToast(`J${i}: speed and accel must be positive`, 'err')
      if (!await api('/config', { joint: i, speed, accel })) return
      n++
    }
    if (!n) return showToast('No changes to apply')
    showToast(`Motion settings applied to ${n} joint${n > 1 ? 's' : ''}`)
    setTimeout(loadConfig, 300)  // the firmware applies them from loop()
  }
  $('cfg-apply').addEventListener('click', applyConfig)
  $('cfg-revert').addEventListener('click', loadConfig)
  ;($('cfg-body').closest('details') as HTMLDetailsElement).addEventListener('toggle', e => {
    if ((e.target as HTMLDetailsElement).open) loadConfig()
  })

  // ── Tool (Cartesian / IK) ───────────────────────────────────────────────────
  const segCart = seg($('seg-cart'), [1, 5, 10, 50], pref('cartStep', 10), v => {
    setPref('cartStep', v); $('dpad-step').textContent = String(v)
  })
  $('dpad-step').textContent = String(segCart.value)

  const fmtJoints = (deg: number[]) => deg.map((v, i) => `J${i + 1} ${fmt(v)}°`).join('  ')
  function setResult(text: string, err = false) {
    const el = $('cart-sol')
    el.textContent = text
    el.className = 'result' + (err ? ' err' : '')
  }

  async function cartGo(dry: boolean) {
    const body: Record<string, number> = {}
    for (const k of ['x', 'y', 'z', 'pitch', 'yaw']) {
      const v = parseFloat($<HTMLInputElement>('cart-' + k).value)
      if (Number.isFinite(v)) body[k] = v
    }
    if (!['x', 'y', 'z', 'pitch'].every(k => k in body)) return setResult('Enter X, Y, Z and pitch', true)
    if (dry) body.dry = 1
    const r = await api<{ deg: number[] }>('/movepose', body)
    if (!r) return setResult('✕ ' + api.lastError, true)
    setResult((dry ? 'REACHABLE ▸ ' : 'MOVING ▸ ') + fmtJoints(r.deg))
    if (!dry) showToast(`Tool → X ${body.x}  Y ${body.y}  Z ${body.z}`)
  }

  function cartFill() {
    if (!lastPose) return showToast('Tool position unknown', 'err')
    for (const k of ['x', 'y', 'z', 'pitch']) $<HTMLInputElement>('cart-' + k).value = (lastPose[k] as number).toFixed(1)
    $<HTMLInputElement>('cart-yaw').value = ''
    showToast('Filled in the current tool pose')
  }

  // Relative to the current target pose; the approach stays in the arm plane
  async function cartJog(axis: string, dir: number) {
    const r = await api<{ deg: number[] }>('/movepose', { [axis]: segCart.value * dir, rel: 1 })
    if (r) setResult('MOVING ▸ ' + fmtJoints(r.deg))
    else setResult('✕ ' + api.lastError, true)
  }

  $('cart-form').addEventListener('submit', e => { e.preventDefault(); cartGo(false) })
  $('cart-check').addEventListener('click', () => cartGo(true))
  $('cart-fill').addEventListener('click', cartFill)
  document.querySelectorAll<HTMLButtonElement>('[data-cart]').forEach(b => b.addEventListener('click', () => {
    const [axis, d] = b.dataset.cart!.split(',')
    cartJog(axis, +d)
  }))

  // ── Gripper ─────────────────────────────────────────────────────────────────
  const sv = $<HTMLInputElement>('servo')
  let servoDragging = false
  sv.addEventListener('input', () => { servoDragging = true; $('servo-val').textContent = sv.value })
  sv.addEventListener('change', () => { servoDragging = false; sendServo(+sv.value) })

  function setServoUI(v: number | null | undefined) {
    if (v == null) return
    sv.value = String(v)
    $('servo-val').textContent = String(v)
  }
  async function sendServo(v: number) {
    v = Math.max(700, Math.min(2300, Math.round(v)))
    setServoUI(v)
    if (await api('/servo', { us: v })) showToast(`Gripper → ${v} µs`)
  }
  document.querySelectorAll<HTMLButtonElement>('[data-servo]').forEach(b =>
    b.addEventListener('click', () => sendServo(+b.dataset.servo!)))
  document.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach(b =>
    b.addEventListener('click', () => sendServo(+sv.value + +b.dataset.nudge!)))

  // ── Tabs, origin, teach ─────────────────────────────────────────────────────
  function showTab(t: string) {
    document.querySelectorAll<HTMLElement>('#view-control .tabs [role=tab]').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === t)))
    $('tab-tool').hidden = t !== 'tool'
    $('tab-joints').hidden = t !== 'joints'
    setPref('tab', t)
  }
  document.querySelectorAll<HTMLElement>('#view-control .tabs [role=tab]').forEach(b =>
    b.addEventListener('click', () => showTab(b.dataset.tab!)))
  showTab(pref('tab', 'tool'))

  confirmTap($('btnOrigin'), async () => {
    if (await api('/home', {})) showToast('Moving all joints to origin')
  })

  $('btnTeach').addEventListener('click', () => teachCurrent())

  // ── Calibration and status rendering ────────────────────────────────────────
  function renderMeters() {
    for (let i = 1; i <= N; i++) {
      const c = cal(i), el = $('mtr-' + i)
      if (!isCal(c)) {
        el.className = 'meter off'
        el.innerHTML = 'Not calibrated &middot; <a href="#calibrate">calibrate</a>'
        continue
      }
      const z = pct(c, 0)
      el.className = 'meter' + (c.limits ? ' lim' : '')
      el.title = c.limits ? 'Soft limits enforced' : 'Soft limits off'
      el.innerHTML = `<div class="trk"></div>` +
        (z >= 0 && z <= 100 ? `<i class="z" style="left:${z}%"></i>` : '') +
        `<i class="m" id="mk-${i}" hidden></i>` +
        `<span class="lo">${fmt(c.min, 0)}&deg;</span><span class="hi">${fmt(c.max, 0)}&deg;</span>`
    }
  }

  function onStatus(d: Status) {
    lastPose = d.x == null ? null : d
    for (const k of ['x', 'y', 'z', 'pitch', 'yaw']) $('p-' + k).textContent = lastPose ? fmt(d[k] as number) : '—'
    $('pose-off').hidden = $('tool-lock').hidden = !!lastPose
    $<HTMLFieldSetElement>('tool-fs').disabled = !lastPose

    for (let i = 1; i <= N; i++) {
      const a = d['a' + i] as number | null, c = cal(i)
      $('led-' + i).className = 'led' + (d['m' + i] ? ' busy' : '')
      $('ang-' + i).innerHTML = a == null ? '<span class="badge warn">No cal</span>' : fmt(a) + '<span class="unit">°</span>'
      $('stp-' + i).textContent = (d['j' + i] ?? '—') + ' st'
      const mk = document.getElementById('mk-' + i)
      if (mk && a != null && c && c.max > c.min) {
        const p = pct(c, a)
        mk.hidden = false
        mk.style.left = Math.max(0, Math.min(100, p)) + '%'
        $('mtr-' + i).classList.toggle('over', p < 0 || p > 100)
      }
    }
    renderJointValues()
    if (!servoDragging) setServoUI(d.servo)
  }

  on('status', onStatus)
  on('calib', () => {
    renderMeters()
    renderJointCtl()
    if (state.status.j1 != null) onStatus(state.status as Status)
  })
  on('connected', ok => { if (ok) loadConfig() })
  on('mode', () => loadConfig())
  renderMeters()
  renderJointCtl()
}

/** Save the current arm position to the library */
export async function teachCurrent(): Promise<void> {
  if (state.status.j1 == null) return showToast('No position from the robot yet', 'err')
  const name = await promptText('Save current position', nextName('P', lib.positions.map(p => p.name)))
  if (!name) return
  const p = capturePosition(state.status, uid(), name)
  lib.positions.push(p)
  changed()
  showToast(`Saved ${name}` + (p.joints?.unit === 'steps' ? ' (in steps: arm not calibrated)' : ''))
}

export function showControl() {
  armView().mount($('a3-control'), 'control')
}
