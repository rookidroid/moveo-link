// Robot connection: the chip in the app bar and the panel it opens, with the
// robot's address, connect / disconnect and a connection test.

import type { Status } from '@shared/types'
import { $, connect, disconnect, on, setHost, state } from '../lib/core'

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

export async function initConnection() {
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

  // The panel opens under the chip, and closes on a click anywhere else or Esc
  const chip = $('btnConn'), pop = $('conn-pop')
  let open = false
  const show = (v: boolean) => {
    open = v
    pop.hidden = !v
    chip.setAttribute('aria-expanded', String(v))
    if (v) $<HTMLInputElement>('set-host').select()
  }
  chip.addEventListener('click', () => show(!open))
  document.addEventListener('pointerdown', e => {
    if (open && !(e.target as HTMLElement).closest('.conn-wrap')) show(false)
  }, { capture: true })
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && open) show(false) })
}
