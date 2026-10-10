import './styles/app.css'
import './styles/link.css'
import './styles/hud.css'
import { armView, type ViewHost } from './lib/arm3d'
import { $, connect, disconnect, emit, pref, setPref, startPolling, state, stopAll } from './lib/core'
import { promptText } from './lib/dialog'
import { loadLibrary } from './lib/library'
import { installWebBridge } from './lib/webBridge'
import { initCalibrate, showCalibrate } from './views/calibrate'
import { initControl } from './views/control'
import { initPositions, showPositions } from './views/positions'
import { initSequences, showSequences } from './views/sequences'
import { initSettings } from './views/settings'

const VIEWS: Record<string, () => void> = {
  control: () => { showPositions(); showSequences() },
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
  armView().setHost(name as ViewHost)
  VIEWS[name]()
  layoutStage()
  emit('view', name)
}

// The 3D view lies behind the active tab's panels: tell it how much of its
// width each column covers. Below 900px the panels stack under the view instead.
const stacked = matchMedia('(max-width: 899px)')
function layoutStage() {
  const col = (side: string) =>
    stacked.matches ? null : document.querySelector<HTMLElement>(`.view.active .hud-${side}`)
  const left = col('left'), right = col('right')
  armView().setInsets(
    left?.offsetWidth ? left.offsetLeft + left.offsetWidth : 0,
    right?.offsetWidth ? $('stage').clientWidth - right.offsetLeft : 0)
}

// Panels fold away, and start as they were left
function initPanels() {
  document.querySelectorAll<HTMLDetailsElement>('details[data-panel]').forEach(d => {
    const key = 'panel.' + d.dataset.panel
    d.open = pref(key, true)
    d.addEventListener('toggle', () => setPref(key, d.open))
  })
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

  initPanels()
  await initSettings()
  initControl()
  initCalibrate()
  initPositions()
  initSequences()
  await loadLibrary()

  window.addEventListener('hashchange', route)
  route()
  const sizes = new ResizeObserver(layoutStage)
  document.querySelectorAll('#stage, .hud-col').forEach(el => sizes.observe(el))
  startPolling()
}

main()
