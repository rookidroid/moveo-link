// Control view: the arm's state and the gripper, ported from the firmware's
// control page (web_index_html.h). The arm itself is moved in the 3D view
// (lib/arm3d.ts); the library panels on the right are positions.ts and
// sequences.ts.

import type { Status } from '@shared/types'
import { $, api, cal, confirmTap, fmt, isCal, JOINT_NAMES, N, on, showToast, state } from '../lib/core'

// Position of angle a on the joint's min..max scale, in %
const pct = (c: { min: number; max: number }, a: number) => (a - c.min) / (c.max - c.min) * 100

export function initControl() {
  // ── Arm state ───────────────────────────────────────────────────────────────
  $('jlist').innerHTML = JOINT_NAMES.map((n, k) => { const i = k + 1; return `
    <div class="jrow">
      <span class="led" id="led-${i}"></span><span class="jtag">J${i}</span><span class="jname">${n}</span>
      <div class="meter" id="mtr-${i}"></div><span class="jang" id="ang-${i}">—</span>
    </div>` }).join('')

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

  // ── Origin ──────────────────────────────────────────────────────────────────
  confirmTap($('btnOrigin'), async () => {
    if (await api('/home', {})) showToast('Moving all joints to origin')
  }, 'Confirm?')

  // ── Calibration and status rendering ────────────────────────────────────────
  function renderMeters() {
    for (let i = 1; i <= N; i++) {
      const c = cal(i), el = $('mtr-' + i)
      if (!isCal(c)) {
        el.className = 'meter off'
        el.title = ''
        el.innerHTML = '<a href="#calibrate">Not calibrated</a>'
        continue
      }
      const z = pct(c, 0)
      el.className = 'meter' + (c.limits ? ' lim' : '')
      el.title = `${fmt(c.min, 0)}° to ${fmt(c.max, 0)}° · soft limits ${c.limits ? 'enforced' : 'off'}`
      el.innerHTML = `<div class="trk"></div>` +
        (z >= 0 && z <= 100 ? `<i class="z" style="left:${z}%"></i>` : '') +
        `<i class="m" id="mk-${i}" hidden></i>`
    }
  }

  function onStatus(d: Status) {
    const known = d.x != null  // the tool's pose needs every joint calibrated
    for (const k of ['x', 'y', 'z', 'pitch', 'yaw']) $('p-' + k).textContent = known ? fmt(d[k] as number) : '—'
    $('pose-off').hidden = known

    for (let i = 1; i <= N; i++) {
      const a = d['a' + i] as number | null, c = cal(i)
      $('led-' + i).className = 'led' + (d['m' + i] ? ' busy' : '')
      // One line a joint: the angle, with the step count behind it; steps alone until calibrated
      const steps = (d['j' + i] ?? '—') + ' st'
      const ang = $('ang-' + i)
      ang.innerHTML = a == null ? `<span class="unit">${steps}</span>` : fmt(a) + '<span class="unit">°</span>'
      ang.title = a == null ? 'Not calibrated' : steps
      const mk = document.getElementById('mk-' + i)
      if (mk && a != null && c && c.max > c.min) {
        const p = pct(c, a)
        mk.hidden = false
        mk.style.left = Math.max(0, Math.min(100, p)) + '%'
        $('mtr-' + i).classList.toggle('over', p < 0 || p > 100)
      }
    }
    if (!servoDragging) setServoUI(d.servo)
  }

  on('status', onStatus)
  on('calib', () => {
    renderMeters()
    if (state.status.j1 != null) onStatus(state.status as Status)
  })
  renderMeters()
}
