// Sequences view: chain positions, gripper actions and waits into a motion,
// preview its tool path in 3D and play it back.

import { SERVO_MAX, SERVO_MIN, uid, type Sequence, type Step } from '@shared/types'
import { armView } from '../lib/arm3d'
import { $, esc, on, publishStatus, request, showToast, state, statusDegrees } from '../lib/core'
import { confirmDialog, promptText } from '../lib/dialog'
import { changed, exportData, findPosition, findSequence, importData, lib, nextName } from '../lib/library'
import { positionDegrees, positionIssues, positionToolPoint } from '../lib/motion'
import { Runner, type RunInfo } from '../lib/runner'

let currentId: string | null = null
let selStep = 0
let quiet = false          // library change made by the step editor itself: keep focus, no re-render
let dragFrom = -1

export const seqRunner = new Runner({
  api: (p, b) => request(p, b),
  position: findPosition,
  onStatus: publishStatus
})

const current = () => (currentId ? findSequence(currentId) ?? null : null)

export function initSequences() {
  $('seq-new').addEventListener('click', async () => {
    const name = await promptText('New sequence', nextName('Sequence ', lib.sequences.map(s => s.name)), 'Create')
    if (!name) return
    const s: Sequence = { id: uid(), name, repeat: 1, steps: [], updatedAt: Date.now() }
    lib.sequences.push(s)
    currentId = s.id
    selStep = 0
    changed()
  })
  $('seq-import').addEventListener('click', async () => {
    const data = await window.moveo.library.importJson()
    if (data == null) return
    const r = importData(data)
    if (typeof r === 'string') return showToast(r, 'err')
    showToast(`Imported ${r.sequences} sequence(s), ${r.positions} position(s)`)
  })
  $('slist').addEventListener('click', e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.srow-s')
    if (!row || seqRunner.busy) return
    currentId = row.dataset.id!
    selStep = 0
    render()
  })

  $('seq-rename').addEventListener('click', async () => {
    const s = current(); if (!s) return
    const name = await promptText('Rename sequence', s.name, 'Rename')
    if (name) { s.name = name; touch(s) }
  })
  $('seq-dup').addEventListener('click', () => {
    const s = current(); if (!s) return
    const copy: Sequence = { ...structuredClone(s), id: uid(), name: s.name + ' copy', updatedAt: Date.now() }
    copy.steps.forEach(st => (st.id = uid()))
    lib.sequences.splice(lib.sequences.indexOf(s) + 1, 0, copy)
    currentId = copy.id
    changed()
  })
  $('seq-export').addEventListener('click', async () => {
    const s = current(); if (!s) return
    if (await window.moveo.library.exportJson(s.name, exportData(s))) showToast(`${s.name} exported`)
  })
  $('seq-del').addEventListener('click', async () => {
    const s = current(); if (!s) return
    if (!await confirmDialog(`Delete sequence "${s.name}"? Its positions stay in the library.`, 'Delete', true)) return
    lib.sequences.splice(lib.sequences.indexOf(s), 1)
    currentId = lib.sequences[0]?.id ?? null
    changed()
  })
  $('seq-repeat').addEventListener('input', () => {
    const s = current(); if (!s) return
    const v = parseInt($<HTMLInputElement>('seq-repeat').value)
    if (Number.isFinite(v) && v >= 0) { s.repeat = v; touch(s, true) }
  })

  $('add-move').addEventListener('click', () => {
    const p = lib.positions[lib.positions.length - 1]
    if (!p) return showToast('Teach a position first (Positions tab)', 'err')
    addStep({ id: uid(), type: 'move', positionId: p.id, speed: 50, dwellMs: 0 })
  })
  $('add-grip').addEventListener('click', () =>
    addStep({ id: uid(), type: 'gripper', us: state.status.servo ?? 1500, settleMs: 500 }))
  $('add-wait').addEventListener('click', () => addStep({ id: uid(), type: 'wait', ms: 1000 }))

  const list = $('steplist')
  list.addEventListener('input', e => onStepInput(e.target as HTMLInputElement | HTMLSelectElement))
  list.addEventListener('change', e => onStepInput(e.target as HTMLInputElement | HTMLSelectElement))
  list.addEventListener('click', e => {
    const t = e.target as HTMLElement
    const row = t.closest<HTMLElement>('.step-row')
    if (!row) return
    const i = +row.dataset.i!
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act) stepAction(i, act)
    else if (!t.closest('input,select')) { selStep = i; renderSteps(); renderPath() }
  })
  list.addEventListener('focusin', e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.step-row')
    if (row && +row.dataset.i! !== selStep) { selStep = +row.dataset.i!; markSelected(); renderPath() }
  })
  list.addEventListener('dragstart', e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.step-row')
    if (!row) return
    dragFrom = +row.dataset.i!
    e.dataTransfer!.effectAllowed = 'move'
    e.dataTransfer!.setData('text/plain', String(dragFrom))
    e.dataTransfer!.setDragImage(row, 20, 20)
    row.classList.add('dragging')
  })
  list.addEventListener('dragover', e => {
    if (dragFrom < 0) return
    e.preventDefault()
    const row = (e.target as HTMLElement).closest<HTMLElement>('.step-row')
    list.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'))
    if (!row) return
    const r = row.getBoundingClientRect()
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after')
  })
  list.addEventListener('drop', e => {
    e.preventDefault()
    const row = (e.target as HTMLElement).closest<HTMLElement>('.step-row')
    const s = current()
    if (!row || !s || dragFrom < 0) return
    let to = +row.dataset.i! + (row.classList.contains('drop-after') ? 1 : 0)
    const [st] = s.steps.splice(dragFrom, 1)
    if (to > dragFrom) to--
    s.steps.splice(to, 0, st)
    selStep = to
    dragFrom = -1
    touch(s)
  })
  list.addEventListener('dragend', () => {
    dragFrom = -1
    list.querySelectorAll('.dragging,.drop-before,.drop-after').forEach(x =>
      x.classList.remove('dragging', 'drop-before', 'drop-after'))
  })

  // ── Playback ────────────────────────────────────────────────────────────────
  $('run-start').addEventListener('click', () => run(0, false))
  $('run-from').addEventListener('click', () => run(selStep, false))
  $('run-step').addEventListener('click', () => run(selStep, true))
  $('run-pause').addEventListener('click', () => {
    if (seqRunner.info.state === 'paused') seqRunner.resume()
    else seqRunner.pause()
  })
  $('run-stop').addEventListener('click', () => seqRunner.stop())
  $('run-validate').addEventListener('click', () => {
    const s = current(); if (!s) return
    const issues = validate(s)
    setMsg(issues.length ? '✕ ' + issues.join('\n✕ ') : `✓ ${s.steps.length} steps look OK`, issues.length > 0)
  })
  seqRunner.onUpdate(onRunUpdate)
  on('estop', () => seqRunner.stop())

  on('library', () => { if (!quiet) render() })
  on('calib', () => renderPath())
  render()
}

export function showSequences() {
  armView().mount($('a3-sequences'), 'sequences')
  renderPath()
}

function touch(s: Sequence, keepFocus = false) {
  s.updatedAt = Date.now()
  quiet = keepFocus
  changed()
  quiet = false
  if (keepFocus) { renderList(); renderPath() }
}

function addStep(st: Step) {
  const s = current(); if (!s) return
  const at = s.steps.length ? Math.min(selStep + 1, s.steps.length) : 0
  s.steps.splice(at, 0, st)
  selStep = at
  touch(s)
}

function stepAction(i: number, act: string) {
  const s = current(); if (!s) return
  const st = s.steps[i]
  if (act === 'up' && i > 0) { [s.steps[i - 1], s.steps[i]] = [st, s.steps[i - 1]]; selStep = i - 1 }
  else if (act === 'down' && i < s.steps.length - 1) { [s.steps[i + 1], s.steps[i]] = [st, s.steps[i + 1]]; selStep = i + 1 }
  else if (act === 'dup') { s.steps.splice(i + 1, 0, { ...structuredClone(st), id: uid() }); selStep = i + 1 }
  else if (act === 'del') { s.steps.splice(i, 1); selStep = Math.max(0, Math.min(selStep, s.steps.length - 1)) }
  else return
  touch(s)
}

function onStepInput(el: HTMLInputElement | HTMLSelectElement) {
  const f = el.dataset.f
  const row = el.closest<HTMLElement>('.step-row')
  const s = current()
  if (!f || !row || !s) return
  const st = s.steps[+row.dataset.i!] as any
  if (f === 'positionId') st.positionId = el.value
  else {
    const v = parseFloat(el.value)
    if (!Number.isFinite(v)) return
    const lim: Record<string, [number, number]> = {
      speed: [1, 100], dwellMs: [0, 3600000], settleMs: [0, 60000], ms: [0, 3600000], us: [SERVO_MIN, SERVO_MAX]
    }
    const [lo, hi] = lim[f]
    st[f] = Math.round(Math.max(lo, Math.min(hi, v)))
    if (el.type === 'number' && (v < lo || v > hi) && document.activeElement !== el) el.value = String(st[f])
  }
  touch(s, true)
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  if (currentId && !findSequence(currentId)) currentId = null
  if (!currentId && lib.sequences.length) currentId = lib.sequences[0].id
  renderList()
  const s = current()
  $('seq-editor').hidden = !s
  $('seq-player').hidden = !s
  if (s) {
    $('seq-editor').querySelector('h2')!.textContent = `Steps · ${s.name}`
    const rep = $<HTMLInputElement>('seq-repeat')
    if (document.activeElement !== rep) rep.value = String(s.repeat)
    selStep = Math.max(0, Math.min(selStep, s.steps.length - 1))
    renderSteps()
  }
  renderPath()
  syncButtons()
}

function renderList() {
  const el = $('slist')
  if (!lib.sequences.length) {
    el.innerHTML = '<div class="empty">No sequences yet. Press <b>New</b>, then add move, gripper and wait steps.</div>'
    return
  }
  el.innerHTML = lib.sequences.map(s => `
    <button type="button" class="srow-s${s.id === currentId ? ' sel' : ''}" data-id="${s.id}">
      <span class="nm">${esc(s.name)}</span>
      <span class="muted">${s.steps.length} step${s.steps.length === 1 ? '' : 's'} · ${s.repeat === 0 ? 'loop' : '×' + s.repeat}</span>
    </button>`).join('')
}

function renderSteps() {
  const s = current()!
  const opts = (sel: string) => lib.positions.map(p =>
    `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('') +
    (findPosition(sel) ? '' : '<option value="" selected>(missing position)</option>')
  const num = (f: string, v: number, unit: string, attrs = '') =>
    `<span class="inp sm"><input type="number" data-f="${f}" value="${v}" ${attrs}/><i>${unit}</i></span>`
  $('steplist').innerHTML = s.steps.length ? s.steps.map((st, i) => `
    <li class="step-row t-${st.type}" data-i="${i}">
      <span class="grip" draggable="true" title="Drag to reorder">&#8942;&#8942;</span>
      <span class="sn">${i + 1}</span>
      <span class="badge stype">${st.type}</span>
      <div class="sfields">${
        st.type === 'move' ? `
          <select data-f="positionId" aria-label="Position">${opts(st.positionId)}</select>
          <label class="sf"><span>Speed</span>${num('speed', st.speed, '%', 'min="1" max="100" step="5"')}</label>
          <label class="sf"><span>Dwell</span>${num('dwellMs', st.dwellMs, 'ms', 'min="0" step="100"')}</label>` :
        st.type === 'gripper' ? `
          <label class="sf"><span>Pulse</span>${num('us', st.us, 'µs', `min="${SERVO_MIN}" max="${SERVO_MAX}" step="10"`)}</label>
          <label class="sf"><span>Settle</span>${num('settleMs', st.settleMs, 'ms', 'min="0" step="100"')}</label>` : `
          <label class="sf"><span>Wait</span>${num('ms', st.ms, 'ms', 'min="0" step="100"')}</label>`}
      </div>
      <div class="sacts">
        <button type="button" class="btn sm ghost" data-act="up" title="Move up">&uarr;</button>
        <button type="button" class="btn sm ghost" data-act="down" title="Move down">&darr;</button>
        <button type="button" class="btn sm ghost" data-act="dup" title="Duplicate">&#10697;</button>
        <button type="button" class="btn sm ghost danger-ink" data-act="del" title="Delete">&times;</button>
      </div>
    </li>`).join('')
    : '<li class="empty">No steps yet. Add a move, gripper or wait step below.</li>'
  markSelected()
}

function markSelected() {
  const run = seqRunner.busy ? seqRunner.info.index : -1
  document.querySelectorAll<HTMLElement>('#steplist .step-row').forEach(r => {
    const i = +r.dataset.i!
    r.classList.toggle('sel', i === selStep)
    r.classList.toggle('running', i === run)
  })
}

/** Tool path through the move steps; joint angles chain from step to step */
function renderPath() {
  if (!$('view-sequences').classList.contains('active')) return
  const s = current()
  const view = armView()
  if (!s) { view.setPath([]); view.setPreview(null); return }
  let seed = statusDegrees()
  const pts: Array<[number, number, number] | null> = []
  const degs: Array<number[] | null> = []
  for (const st of s.steps) {
    const p = st.type === 'move' ? findPosition(st.positionId) : undefined
    const deg = p ? positionDegrees(p, state.calib, seed) : null
    pts.push(p ? positionToolPoint(p, state.calib, seed) : null)
    degs.push(deg)
    if (deg) seed = deg
  }
  const active = seqRunner.busy ? seqRunner.info.index : selStep
  view.setPath(pts, active)
  view.setPreview(degs[active] ?? null)
}

function validate(s: Sequence): string[] {
  const out: string[] = []
  if (!s.steps.length) out.push('the sequence has no steps')
  let seed = statusDegrees()
  s.steps.forEach((st, i) => {
    if (st.type !== 'move') return
    const p = findPosition(st.positionId)
    if (!p) return out.push(`step ${i + 1}: position is missing`)
    for (const issue of positionIssues(p, state.calib, seed)) out.push(`step ${i + 1} (${p.name}): ${issue}`)
    seed = positionDegrees(p, state.calib, seed) ?? seed
  })
  return out
}

// ── Playback ─────────────────────────────────────────────────────────────────
async function run(from: number, single: boolean) {
  const s = current()
  if (!s || seqRunner.busy) return
  if (!s.steps.length) return showToast('Add some steps first', 'err')
  if (state.mode === 'robot' && state.connected === false) return showToast('Robot offline', 'err')
  const issues = validate(s)
  if (issues.length) {
    setMsg('✕ ' + issues.join('\n✕ '), true)
    return showToast('Fix the issues before running', 'err')
  }
  await seqRunner.run(s, { from, single })
  if (single && seqRunner.info.state === 'idle') { selStep = seqRunner.info.index; markSelected(); renderPath() }
}

function setMsg(text: string, err = false) {
  const el = $('run-msg')
  el.textContent = text
  el.className = 'result' + (err ? ' err' : '')
}

function onRunUpdate(i: RunInfo) {
  const s = current()
  const total = s?.steps.length || 1
  const label = { idle: 'Idle', running: 'Running', paused: 'Paused', error: 'Error' }[i.state]
  $('run-state').textContent = label
  $('run-state').className = 'badge' + (i.state === 'running' ? ' ok' : i.state === 'idle' ? '' : ' warn')
  const busy = i.state === 'running' || i.state === 'paused'
  $('run-bar').style.width = busy ? `${((i.index + (i.state === 'running' ? 0.5 : 0)) / total) * 100}%` : '0%'
  const loop = i.loops === 0 ? `loop ${i.loop}` : `loop ${i.loop}/${i.loops}`
  setMsg(busy ? `${loop} · step ${i.index + 1}/${total} · ${i.message}` : i.message, i.state === 'error')

  const chip = $('run-chip')
  chip.hidden = !busy
  chip.textContent = busy ? `${i.state === 'paused' ? '❚❚' : '▶'} ${s?.name ?? ''} ${i.index + 1}/${total}` : ''
  $<HTMLFieldSetElement>('seq-fs').disabled = busy
  markSelected()
  renderPath()
  syncButtons()
}

function syncButtons() {
  const st = seqRunner.info.state
  const busy = st === 'running' || st === 'paused'
  const has = !!current()?.steps.length
  $<HTMLButtonElement>('run-start').disabled = busy || !has
  $<HTMLButtonElement>('run-from').disabled = busy || !has
  $<HTMLButtonElement>('run-step').disabled = busy || !has
  $<HTMLButtonElement>('run-pause').disabled = !busy
  $('run-pause').innerHTML = st === 'paused' ? '&#9656; Resume' : '&#10073;&#10073; Pause'
  $<HTMLButtonElement>('run-stop').disabled = !busy
  ;['seq-rename', 'seq-dup', 'seq-del', 'seq-new', 'seq-import'].forEach(id => ($<HTMLButtonElement>(id).disabled = busy))
}
