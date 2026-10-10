// Settings view: robot address, connect / disconnect and a connection test,
// and the joints' speeds and accelerations.

import type { MotionConfig, Status } from '@shared/types'
import { $, api, connect, disconnect, JOINT_NAMES, N, on, setHost, showToast, state } from '../lib/core'

let CFG: MotionConfig = {}

function setRes(text: string, err = false) {
  const el = $('set-res')
  el.textContent = text
  el.className = 'result' + (err ? ' err' : '')
}

/** Ping the robot without leaving the current mode */
async function test() {
  const host = $<HTMLInputElement>('set-host').value.trim()
  if (host && host !== state.host) setHost((await window.movens.settings.set({ host })).host)
  setRes(`Testing ${state.host}…`)
  const t0 = performance.now()
  const r = await window.movens.api('/status')
  const ms = Math.round(performance.now() - t0)
  if (!r.ok) return setRes(`✕ ${state.host}: ${r.error}`, true)
  const d = r.data as Status
  const calibrated = [1, 2, 3, 4, 5].filter(i => d['a' + i] != null).length
  setRes(`✓ ${state.host} answered in ${ms} ms · ${calibrated}/5 joints calibrated`)
}

function renderMode() {
  const robot = state.mode === 'robot'
  $('set-mode').textContent = robot ? `Connected to ${state.host}` : 'Simulation (not connected)'
  $('set-mode').className = 'badge ' + (robot ? 'ok' : 'sim')
  $('set-connect').textContent = robot ? 'Reconnect' : 'Connect'
  $('set-disconnect').hidden = !robot
}

export async function initSettings() {
  const s = await window.movens.settings.get()
  setHost(s.host)
  $<HTMLInputElement>('set-host').value = s.host
  $('set-form').addEventListener('submit', async e => {
    e.preventDefault()
    setRes('')
    if (await connect($<HTMLInputElement>('set-host').value.trim() || undefined)) test()
  })
  $('set-test').addEventListener('click', test)
  $('set-disconnect').addEventListener('click', () => disconnect())
  on('host', h => { if (document.activeElement !== $('set-host')) $<HTMLInputElement>('set-host').value = h })
  on('mode', renderMode)
  renderMode()

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
  on('connected', ok => { if (ok) loadConfig() })
  on('mode', () => loadConfig())
}
