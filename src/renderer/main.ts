import './styles/app.css'
import './styles/link.css'
import { $, connect, disconnect, emit, startPolling, state, stopAll } from './lib/core'
import { promptText } from './lib/dialog'
import { loadLibrary } from './lib/library'
import { installWebBridge } from './lib/webBridge'
import { initCalibrate, showCalibrate } from './views/calibrate'
import { initControl, showControl } from './views/control'
import { initPositions, showPositions } from './views/positions'
import { initSequences, showSequences } from './views/sequences'
import { initSettings } from './views/settings'

const VIEWS: Record<string, () => void> = {
  control: showControl,
  positions: showPositions,
  sequences: showSequences,
  calibrate: showCalibrate,
  settings: () => {}
}

function route() {
  const name = location.hash.slice(1) in VIEWS ? location.hash.slice(1) : 'control'
  document.querySelectorAll<HTMLElement>('.view').forEach(v => {
    const on = v.id === 'view-' + name
    v.hidden = !on
    v.classList.toggle('active', on)
  })
  document.querySelectorAll<HTMLAnchorElement>('#nav a').forEach(a => {
    const on = a.dataset.view === name
    a.classList.toggle('active', on)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
  VIEWS[name]()
  emit('view', name)
}

async function main() {
  installWebBridge()  // no-op inside Electron
  $('btnStop').addEventListener('click', stopAll)
  // Connect asks for the address (prefilled with the last one); until then
  // every view drives the built-in simulated arm
  $('btnConn').addEventListener('click', async () => {
    if (state.mode === 'robot') return disconnect()
    const host = await promptText('Connect to robot (join the movens WiFi first)', state.host, 'Connect')
    if (host) connect(host)
  })
  // Esc is the E-stop everywhere, even while typing in a field
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.repeat) stopAll()
  }, { capture: true })

  await initSettings()
  initControl()
  initCalibrate()
  initPositions()
  initSequences()
  await loadLibrary()

  window.addEventListener('hashchange', route)
  route()
  startPolling()
}

main()
