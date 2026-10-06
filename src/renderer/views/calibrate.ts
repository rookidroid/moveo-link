// Calibrate view: port of the firmware's calibration page (web_calib_html.h).
// Model: steps = (deg - home) * spd, with step 0 at the alignment pose.
// Each joint is calibrated by turning it exactly 90° from the alignment pose:
// spd = steps / (±90). Only spd/home/limits are stored on the robot.

import type { Status } from '@shared/types'
import { $, api, fmt, isCal, JOINT_NAMES, loadCalib, on, pref, seg, setPref, showToast, state } from '../lib/core'
import { confirmDialog } from '../lib/dialog'

interface Progress { ref?: boolean; meas?: boolean; saved?: boolean; verify?: boolean }

let curJ: number = pref('calJoint', 1)
const PROG: Record<string, Progress> = {}  // per joint: steps finished in this session
const STEP_KEYS: Array<keyof Progress> = ['ref', 'meas', 'saved', 'verify']

const num = (id: string) => parseFloat($<HTMLInputElement>(id).value)
const setFit = (t: string) => ($('cal-fit').textContent = t)
const CAL = () => state.calib

export function initCalibrate() {
  const segCal = seg($('seg-cal'), [1, 10, 100, 1000], pref('calStep', 100), v => setPref('calStep', v))

  $('jpick').innerHTML = JOINT_NAMES.map((n, k) => { const i = k + 1; return `
    <button class="jp" role="tab" id="jp-${i}" data-j="${i}">
      <span class="jtag">J${i}</span><span class="nm">${n}</span><span class="st" id="jps-${i}">—</span>
    </button>` }).join('')
  $('jpick').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.jp')
    if (b) pickJoint(+b.dataset.j!)
  })

  // Show each joint's calibration state in the picker
  function renderJointOptions() {
    for (let i = 1; i <= JOINT_NAMES.length; i++) {
      const c = CAL()['j' + i], ok = isCal(c), el = $('jps-' + i)
      el.innerHTML = ok ? `✓<span class="spd"> ${c.spd.toFixed(2)}/°</span>` : 'Not set'
      el.className = 'st' + (ok ? ' ok' : '')
      $('jp-' + i).setAttribute('aria-selected', String(i === curJ))
    }
  }

  async function pickJoint(i: number) {
    if (i === curJ) return
    if (isDirty() && !await confirmDialog(`Discard unsaved calibration changes for J${curJ}?`, 'Discard')) return
    curJ = i
    setPref('calJoint', i)
    renderJointOptions()
    fillCalForm()
  }

  function fillCalForm() {
    const c = CAL()['j' + curJ]
    if (c) {
      $<HTMLInputElement>('cal-home').value = String(c.home)
      $<HTMLInputElement>('cal-spd').value = String(c.spd)
      $<HTMLInputElement>('cal-min').value = String(c.min)
      $<HTMLInputElement>('cal-max').value = String(c.max)
      $<HTMLInputElement>('cal-lim').checked = c.limits
    }
    $('cal-jname').textContent = `J${curJ} ${JOINT_NAMES[curJ - 1]}`
    setFit('')
    renderCalPos()
    renderSteps()
    updateDirty()
  }

  function renderCalPos() {
    const S = state.status, j = curJ, s = S['j' + j], a = S['a' + j], ok = isCal(CAL()['j' + j])
    $('cal-steps').textContent = s == null ? '—' : String(s)
    $('cal-ang').textContent = a == null ? '—' : fmt(a)
    $('cal-led').className = 'led' + (S['m' + j] ? ' busy' : '')
    $('cal-state').textContent = ok ? 'Calibrated' : 'Not calibrated'
    $('cal-state').className = 'badge ' + (ok ? 'ok' : 'warn')
  }

  // ── Wizard progress ─────────────────────────────────────────────────────────
  const prog = () => PROG['j' + curJ] || (PROG['j' + curJ] = {})

  function renderSteps() {
    const p = prog(), next = STEP_KEYS.findIndex(k => !p[k])
    STEP_KEYS.forEach((k, i) => {
      $('st-' + (i + 1)).classList.toggle('done', !!p[k])
      $('st-' + (i + 1)).classList.toggle('next', i === next)
    })
  }
  function markStep(k: keyof Progress, extra: Progress = {}) { Object.assign(prog(), { [k]: true }, extra); renderSteps() }

  // Form differs from the calibration stored on the robot
  function isDirty() {
    const c = CAL()['j' + curJ]
    if (!c) return false
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
    return !(near(num('cal-spd'), c.spd, 1e-5) && near(num('cal-min'), c.min, 0.005) &&
             near(num('cal-max'), c.max, 0.005) && $<HTMLInputElement>('cal-lim').checked === !!c.limits)
  }
  function updateDirty() { $('cal-dirty').hidden = !isDirty() }
  for (const id of ['cal-spd', 'cal-min', 'cal-max']) $(id).addEventListener('input', updateDirty)
  $('cal-lim').addEventListener('change', updateDirty)

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function calJog(dir: number) {
    await api('/move', { joint: curJ, steps: segCal.value * dir })
  }

  async function calSetReference() {
    const j = curJ, home = num('cal-home')
    if (!Number.isFinite(home)) return showToast('Enter the alignment angle', 'err')
    if (!await api('/calib', { joint: j, home })) return
    if (!await api('/setpos', { joint: j, deg: home })) return
    if (CAL()['j' + j]) CAL()['j' + j].home = home
    setFit('')
    markStep('ref', { verify: false })
    showToast(`J${j}: alignment pose = 0 steps = ${home}°`)
  }

  // The joint now sits exactly sign*90° from the alignment pose (step 0)
  async function calAt90(sign: number) {
    const j = curJ
    const d = await api<Status>('/status')  // fresh reading, not the last poll
    if (!d) return
    if (d['m' + j]) return showToast('Wait until the joint stops', 'err')
    const steps = d['j' + j] as number
    if (!steps) return showToast('Joint is still at 0 steps — jog it to 90° first', 'err')
    const spd = steps / (sign * 90)
    $<HTMLInputElement>('cal-spd').value = spd.toFixed(5)
    setFit(`${steps} steps for ${sign > 0 ? '+' : '−'}90° → ${spd.toFixed(4)} steps/°. Save to store it.`)
    markStep('meas', { saved: false, verify: false })
    updateDirty()
  }

  async function calSetLimit(which: 'min' | 'max') {
    const j = curJ, spd = num('cal-spd'), home = num('cal-home')
    if (!Number.isFinite(spd) || Math.abs(spd) < 1e-9) return showToast('Do the 90° step first', 'err')
    const d = await api<Status>('/status')
    if (!d) return
    $<HTMLInputElement>('cal-' + which).value = (home + (d['j' + j] as number) / spd).toFixed(1)
    updateDirty()
  }

  async function calSave() {
    const j = curJ
    const body = {
      joint: j, spd: num('cal-spd'), home: num('cal-home'),
      min: num('cal-min'), max: num('cal-max'),
      limits: $<HTMLInputElement>('cal-lim').checked ? 1 : 0
    }
    if (![body.spd, body.home, body.min, body.max].every(Number.isFinite))
      return showToast('All calibration fields must be numbers', 'err')
    if (await api('/calib', body)) {
      showToast(`J${j} calibration saved`)
      markStep('saved', { verify: false })
      await loadCalib()
    }
  }

  async function calGo90(sign: number) {
    const j = curJ, deg = num('cal-home') + sign * 90
    if (await api('/moveangle', { joint: j, deg })) { showToast(`J${j} → ${deg}°`); markStep('verify') }
  }

  async function calGoReference() {
    if (await api('/moveto', { joint: curJ, pos: 0 })) showToast(`J${curJ} → alignment pose`)
  }

  $('cal-jog-neg').addEventListener('click', () => calJog(-1))
  $('cal-jog-pos').addEventListener('click', () => calJog(1))
  $('cal-setref').addEventListener('click', calSetReference)
  $('cal-at90p').addEventListener('click', () => calAt90(1))
  $('cal-at90n').addEventListener('click', () => calAt90(-1))
  $('cal-usemin').addEventListener('click', () => calSetLimit('min'))
  $('cal-usemax').addEventListener('click', () => calSetLimit('max'))
  $('cal-save').addEventListener('click', calSave)
  $('cal-go90p').addEventListener('click', () => calGo90(1))
  $('cal-go90n').addEventListener('click', () => calGo90(-1))
  $('cal-goref').addEventListener('click', calGoReference)

  let filled = false
  function onCalib() {
    for (let j = 1; j <= JOINT_NAMES.length; j++) {
      // A joint calibrated earlier starts with steps 1–3 done
      if (!PROG['j' + j]) { const ok = isCal(CAL()['j' + j]); PROG['j' + j] = { ref: ok, meas: ok, saved: ok } }
    }
    renderJointOptions()
    if (!filled) { filled = true; fillCalForm() } else { updateDirty(); renderCalPos() }
  }

  on('status', renderCalPos)
  on('calib', onCalib)
  on('mode', () => { filled = false })  // refill the form from the new arm's calibration
  $('cal-jname').textContent = `J${curJ} ${JOINT_NAMES[curJ - 1]}`
  renderSteps()
}

export function showCalibrate() {
  // Refresh in case the robot was calibrated from elsewhere
  loadCalib()
}
