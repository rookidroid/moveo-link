import './styles/app.css'
import './styles/link.css'
import './styles/hud.css'
import { armView } from './lib/arm3d'
import { $, pref, setPref, startPolling, state, stopAll } from './lib/core'
import { loadLibrary } from './lib/library'
import { installWebBridge } from './lib/webBridge'
import { initConnection } from './views/connection'
import { initControl } from './views/control'
import { initPositions, showPositions } from './views/positions'
import { initSequences, showSequences } from './views/sequences'

// The 3D view lies behind the panels: tell it how much of its width each
// column covers. Below 900px the panels stack under the view instead.
const stacked = matchMedia('(max-width: 899px)')
function layoutStage() {
  const col = (side: string) =>
    stacked.matches ? null : document.querySelector<HTMLElement>(`.hud-${side}`)
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
  // Esc is the E-stop everywhere, even while typing in a field
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.repeat) stopAll()
  }, { capture: true })
  // Joints are calibrated on the robot's own web page: the links to it open in the browser
  document.addEventListener('click', e => {
    if (!(e.target as HTMLElement).closest('a[href="#calibrate"]')) return
    e.preventDefault()
    window.open(`http://${state.host}/calibrate`, '_blank')
  })

  initPanels()
  await initConnection()
  initControl()
  initPositions()
  initSequences()
  await loadLibrary()

  showPositions()
  showSequences()
  layoutStage()
  const sizes = new ResizeObserver(layoutStage)
  document.querySelectorAll('#stage, .hud-col').forEach(el => sizes.observe(el))
  startPolling()
}

main()
