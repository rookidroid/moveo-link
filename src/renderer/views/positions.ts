// Positions panel of the Control view: teach, edit, preview and go to named
// arm positions.

import { forwardKinematics, inverseKinematics } from '@shared/kinematics'
import { SERVO_MAX, SERVO_MIN, uid, type Position } from '@shared/types'
import { armView } from '../lib/arm3d'
import {
  $, cal, emit, esc, fmt, isCal, jointLimits, on, pref, publishStatus, request, seg, setPref, showToast,
  state, statusDegrees, type Seg
} from '../lib/core'
import { confirmDialog, promptText } from '../lib/dialog'
import { changed, exportData, findPosition, importData, lib, nextName, sequencesUsing } from '../lib/library'
import {
  capturePosition, describePosition, poseFromDegrees, positionDegrees, positionIssues
} from '../lib/motion'
import { Runner } from '../lib/runner'

let selected: string | null = null
let draft: Position | null = null   // being edited; id may not be in the library yet
let owns = false                    // the ghost shows this panel's pick, not a sequence step
let segKind: Seg<'joints' | 'pose'>
let segUnit: Seg<'deg' | 'steps'>
let segSpeed: Seg<number>

// Ad-hoc "Go": a one-step run, so the gripper is applied after the arm arrives
const goRunner = new Runner({
  api: (p, b) => request(p, b),
  position: id => (draft?.id === id ? draft : findPosition(id)),
  onStatus: publishStatus
})
goRunner.onUpdate(i => {
  if (i.state === 'error') showToast(i.message.replace(/^Step 1: /, ''), 'err')
})

export function initPositions() {
  segSpeed = seg($('seg-gospeed'), [[10, '10%'], [25, '25%'], [50, '50%'], [100, '100%']], pref('goSpeed', 50),
    v => setPref('goSpeed', v))

  $('pos-teach').addEventListener('click', () => teachCurrent())
  $('pos-new-pose').addEventListener('click', () => {
    const deg = statusDegrees()
    const pose = deg ? poseFromDegrees(deg) : { x: 300, y: 0, z: 200, pitch: -90 }
    pose.yaw = null
    openEditor({
      id: uid(), name: nextName('P', lib.positions.map(p => p.name)), kind: 'pose', pose,
      gripper: null, updatedAt: Date.now()
    }, true)
  })
  $('pos-export').addEventListener('click', async () => {
    if (!lib.positions.length) return showToast('Nothing to export', 'err')
    if (await window.movens.library.exportJson('movens-library', exportData())) showToast('Library exported')
  })
  $('pos-import').addEventListener('click', doImport)

  $('plist').addEventListener('click', e => {
    const t = e.target as HTMLElement
    const row = t.closest<HTMLElement>('.prow')
    if (!row) return
    const p = findPosition(row.dataset.id!)
    if (!p) return
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'go') goTo(p)
    else if (act === 'edit') openEditor(structuredClone(p), false)
    else if (act === 'reteach') reteach(p)
    else if (act === 'dup') duplicate(p)
    else if (act === 'del') remove(p)
    else if (act === 'rename') rename(p)
    else select(p.id)
  })

  // ── Editor ──────────────────────────────────────────────────────────────────
  segKind = seg($('pe-kind'), [['joints', 'Joints'], ['pose', 'Tool pose']], 'joints', k => switchKind(k))
  segUnit = seg($('pe-unit'), [['deg', 'Degrees'], ['steps', 'Steps']], 'deg', u => switchUnit(u))
  $('pe-jfields').innerHTML = [1, 2, 3, 4, 5].map(i => `
    <label class="field"><span>J${i}</span><span class="inp"><input type="number" step="any" id="pe-j${i}"/><i class="pe-u">°</i></span></label>`).join('')
  $('pe-form').addEventListener('input', () => { readForm(); claim(); renderDraftInfo() })
  $('pe-form').addEventListener('submit', e => { e.preventDefault(); saveDraft() })
  $('pe-cancel').addEventListener('click', closeEditor)
  $('pe-from-arm').addEventListener('click', fillFromArm)
  $('pe-grip-on').addEventListener('change', () => {
    $<HTMLInputElement>('pe-grip').disabled = !$<HTMLInputElement>('pe-grip-on').checked
    if (!$<HTMLInputElement>('pe-grip').value) $<HTMLInputElement>('pe-grip').value = String(state.status.servo ?? 1500)
    readForm()
  })

  on('library', render)
  on('calib', () => { render(); renderDraftInfo() })
  on('preview', who => {  // a sequence step took the ghost
    if (who !== 'step') return
    owns = false
    selected = null
    render()
  })
  render()
}

/** Save the current arm position to the library */
async function teachCurrent(): Promise<void> {
  if (state.status.j1 == null) return showToast('No position from the robot yet', 'err')
  const name = await promptText('Save current position', nextName('P', lib.positions.map(p => p.name)))
  if (!name) return
  const p = capturePosition(state.status, uid(), name)
  lib.positions.push(p)
  changed()
  showToast(`Saved ${name}` + (p.joints?.unit === 'steps' ? ' (in steps: arm not calibrated)' : ''))
}

// ── List ─────────────────────────────────────────────────────────────────────
function render() {
  if (selected && !findPosition(selected)) selected = null
  const el = $('plist')
  if (!lib.positions.length) {
    el.innerHTML = `<div class="empty">No positions yet. Move the arm and press <b>Save current</b>,
      or click the gripper or a link in the 3D view, drag it, and <b>Save position</b>.</div>`
    updatePreview()
    return
  }
  const seed = statusDegrees()
  el.innerHTML = lib.positions.map(p => {
    const issues = positionIssues(p, state.calib, seed)
    const used = sequencesUsing(p.id).length
    return `
    <div class="prow${p.id === selected ? ' sel' : ''}" data-id="${p.id}">
      <div class="pmain">
        <div class="ptop">
          <button type="button" class="pname" data-act="rename" title="Rename">${esc(p.name)}</button>
          <span class="badge">${p.kind === 'pose' ? 'Tool pose' : p.joints?.unit === 'steps' ? 'Joints · steps' : 'Joints'}</span>
          ${p.gripper != null ? `<span class="badge">Grip ${p.gripper}</span>` : ''}
          ${used ? `<span class="badge" title="Used by ${used} sequence(s)">×${used}</span>` : ''}
          ${issues.length ? `<span class="badge warn" title="${esc(issues.join('\n'))}">! ${esc(issues[0])}</span>` : ''}
        </div>
        <div class="pvals">${esc(describePosition(p))}</div>
        ${p.note ? `<div class="muted pnote">${esc(p.note)}</div>` : ''}
      </div>
      <button type="button" class="btn sm primary" data-act="go" title="Move there; a saved gripper value is applied after the arm arrives">Go</button>
      <div class="pacts">
        <button type="button" class="btn sm" data-act="edit">Edit</button>
        <button type="button" class="btn sm ghost" data-act="reteach" title="Replace with the current arm position">Set to current</button>
        <button type="button" class="btn sm ghost" data-act="dup">Duplicate</button>
        <button type="button" class="btn sm ghost danger-ink" data-act="del" title="Delete">&times;</button>
      </div>
    </div>`
  }).join('')
  updatePreview()
}

function select(id: string | null) {
  selected = selected === id ? null : id
  if (selected) claim()
  render()
}

/** Take the ghost for the selected position or the one being edited; the
 *  Sequences panel lets go of it */
function claim() {
  if (owns) return
  owns = true
  emit('preview', 'position')
}

function updatePreview() {
  const p = owns ? draft ?? (selected ? findPosition(selected) : null) : null
  const deg = p ? positionDegrees(p, state.calib, statusDegrees()) : null
  $('pos-preview-name').textContent = p ? (deg ? `Ghost: ${p.name}` : `${p.name}: no preview`) : ''
  if (!owns) return
  armView().setPreview(deg)
  if (!p) owns = false
}

async function goTo(p: Position) {
  const issues = positionIssues(p, state.calib, statusDegrees())
  if (issues.length) return showToast(`${p.name}: ${issues[0]}`, 'err')
  if (goRunner.busy) await goRunner.stop()
  showToast(`Moving to ${p.name} at ${segSpeed.value}%`)
  goRunner.run({ id: 'go', name: 'go', repeat: 1, updatedAt: 0,
    steps: [{ id: 'go', type: 'move', positionId: p.id, speed: segSpeed.value, dwellMs: 0 }] })
}

on('estop', () => { if (goRunner.busy) goRunner.stop() })

async function reteach(p: Position) {
  if (state.status.j1 == null) return showToast('No position from the robot yet', 'err')
  if (!await confirmDialog(`Replace "${p.name}" with the current arm position?`, 'Replace')) return
  const snap = capturePosition(state.status, p.id, p.name)
  if (p.kind === 'pose' && snap.pose) {
    p.pose = { ...snap.pose, yaw: p.pose?.yaw == null ? null : snap.pose.yaw }
  } else {
    p.kind = 'joints'
    p.joints = snap.joints
  }
  if (p.gripper != null) p.gripper = snap.gripper
  p.updatedAt = Date.now()
  changed()
  showToast(`${p.name} updated`)
}

function duplicate(p: Position) {
  const copy: Position = { ...structuredClone(p), id: uid(), name: nextName(p.name + ' copy ', lib.positions.map(x => x.name)).replace(/ copy 1$/, ' copy'), updatedAt: Date.now() }
  lib.positions.splice(lib.positions.indexOf(p) + 1, 0, copy)
  changed()
}

async function rename(p: Position) {
  const name = await promptText('Rename position', p.name, 'Rename')
  if (!name) return
  p.name = name
  p.updatedAt = Date.now()
  changed()
}

async function remove(p: Position) {
  const seqs = sequencesUsing(p.id)
  const msg = seqs.length
    ? `"${p.name}" is used by: ${seqs.map(s => s.name).join(', ')}.\nIts move steps will be removed from those sequences.`
    : `Delete "${p.name}"?`
  if (!await confirmDialog(msg, 'Delete', true)) return
  for (const s of seqs) s.steps = s.steps.filter(st => !(st.type === 'move' && st.positionId === p.id))
  lib.positions.splice(lib.positions.indexOf(p), 1)
  if (draft?.id === p.id) closeEditor()
  changed()
}

async function doImport() {
  const data = await window.movens.library.importJson()
  if (data == null) return
  const r = importData(data)
  if (typeof r === 'string') return showToast(r, 'err')
  showToast(`Imported ${r.positions} position(s), ${r.sequences} sequence(s)`)
}

// ── Editor ───────────────────────────────────────────────────────────────────
let isNew = false

function openEditor(p: Position, fresh: boolean) {
  draft = p
  isNew = fresh
  if (!draft.joints) {
    const deg = statusDegrees() ?? [0, 0, 0, 0, 0]
    draft.joints = { unit: 'deg', v: deg.map(v => +v.toFixed(2)) }
  }
  if (!draft.pose) draft.pose = { x: 300, y: 0, z: 200, pitch: -90, yaw: null }
  $('pe-title').textContent = fresh ? 'New position' : `Edit ${p.name}`
  $('pos-editor').hidden = false
  claim()
  writeForm()
  renderDraftInfo()
  $('pos-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function closeEditor() {
  draft = null
  $('pos-editor').hidden = true
  updatePreview()
}

const inp = (id: string) => $<HTMLInputElement>(id)
const val = (id: string) => parseFloat(inp(id).value)
const r2 = (v: number) => +v.toFixed(2)

function writeForm() {
  const d = draft!
  inp('pe-name').value = d.name
  inp('pe-note').value = d.note ?? ''
  segKind.set([['joints', 'Joints'], ['pose', 'Tool pose']], d.kind)
  segUnit.set([['deg', 'Degrees'], ['steps', 'Steps']], d.joints!.unit)
  d.joints!.v.forEach((v, k) => (inp('pe-j' + (k + 1)).value = String(v)))
  document.querySelectorAll('.pe-u').forEach(e => (e.textContent = d.joints!.unit === 'deg' ? '°' : 'st'))
  const q = d.pose!
  for (const k of ['x', 'y', 'z', 'pitch'] as const) inp('pe-' + k).value = String(r2(q[k]))
  inp('pe-yaw').value = q.yaw == null ? '' : String(r2(q.yaw))
  inp('pe-grip-on').checked = d.gripper != null
  inp('pe-grip').disabled = d.gripper == null
  inp('pe-grip').value = d.gripper == null ? '' : String(d.gripper)
  $('pe-joints').hidden = d.kind !== 'joints'
  $('pe-pose').hidden = d.kind !== 'pose'
}

function readForm() {
  const d = draft
  if (!d) return
  d.name = inp('pe-name').value.trim()
  d.note = inp('pe-note').value.trim() || undefined
  d.joints!.v = [1, 2, 3, 4, 5].map(i => val('pe-j' + i))
  const yaw = val('pe-yaw')
  d.pose = { x: val('pe-x'), y: val('pe-y'), z: val('pe-z'), pitch: val('pe-pitch'), yaw: Number.isFinite(yaw) ? yaw : null }
  d.gripper = inp('pe-grip-on').checked && Number.isFinite(val('pe-grip'))
    ? Math.max(SERVO_MIN, Math.min(SERVO_MAX, Math.round(val('pe-grip')))) : null
}

function renderDraftInfo() {
  if (!draft) return
  const issues = positionIssues(draft, state.calib, statusDegrees())
  const res = $('pe-issues')
  res.textContent = issues.length ? '✕ ' + issues.join(' · ') : ''
  res.className = 'result' + (issues.length ? ' err' : '')
  const deg = draft.kind === 'joints' ? positionDegrees(draft, state.calib) : null
  if (deg && deg.every(Number.isFinite)) {
    const f = forwardKinematics(deg)
    $('pe-fk').textContent = `Tool  X ${fmt(f.x)}  Y ${fmt(f.y)}  Z ${fmt(f.z)}  P ${fmt(f.pitch)}°`
  } else $('pe-fk').textContent = ''
  updatePreview()
}

function switchKind(k: 'joints' | 'pose') {
  claim()
  readForm()
  const d = draft!
  if (k === d.kind) return
  if (k === 'pose') {
    const deg = positionDegrees(d, state.calib)
    if (deg && deg.every(Number.isFinite)) d.pose = { ...poseFromDegrees(deg), yaw: null }
  } else {
    const { lo, hi } = jointLimits()
    const r = inverseKinematics(d.pose!, statusDegrees() ?? [0, 0, 0, 0, 0], lo, hi)
    if (r.status === 'ok') d.joints = { unit: 'deg', v: r.deg.map(r2) }
    else showToast('Pose not reachable: joint values left unchanged', 'err')
  }
  d.kind = k
  writeForm()
  renderDraftInfo()
}

function switchUnit(u: 'deg' | 'steps') {
  claim()
  readForm()
  const j = draft!.joints!
  if (u === j.unit) return
  const missing = [1, 2, 3, 4, 5].filter(i => !isCal(cal(i)))
  if (missing.length) {
    segUnit.set([['deg', 'Degrees'], ['steps', 'Steps']], j.unit)
    return showToast(`J${missing[0]} is not calibrated: can't convert`, 'err')
  }
  j.v = j.v.map((v, k) => {
    const c = cal(k + 1)
    return u === 'steps' ? Math.round((v - c.home) * c.spd) : r2(c.home + v / c.spd)
  })
  j.unit = u
  writeForm()
  renderDraftInfo()
}

function fillFromArm() {
  if (state.status.j1 == null) return showToast('No position from the robot yet', 'err')
  claim()
  readForm()
  const snap = capturePosition(state.status, draft!.id, draft!.name)
  if (draft!.kind === 'pose') {
    if (!snap.pose) return showToast('Tool pose unknown: calibrate J1–J5', 'err')
    draft!.pose = { ...snap.pose, yaw: null }
  } else draft!.joints = snap.joints
  writeForm()
  renderDraftInfo()
}

function saveDraft() {
  readForm()
  const d = draft!
  if (!d.name) return showToast('Enter a name', 'err')
  if (d.kind === 'joints' && !d.joints!.v.every(Number.isFinite)) return showToast('Enter all five joint values', 'err')
  if (d.kind === 'pose' && ![d.pose!.x, d.pose!.y, d.pose!.z, d.pose!.pitch].every(Number.isFinite))
    return showToast('Enter X, Y, Z and pitch', 'err')
  const clean: Position = {
    id: d.id, name: d.name, kind: d.kind, gripper: d.gripper, updatedAt: Date.now(),
    ...(d.note ? { note: d.note } : {}),
    ...(d.kind === 'joints' ? { joints: d.joints } : { pose: d.pose })
  }
  const i = lib.positions.findIndex(p => p.id === d.id)
  if (i >= 0) lib.positions[i] = clean
  else lib.positions.push(clean)
  selected = clean.id
  claim()
  showToast(`${isNew ? 'Added' : 'Saved'} ${clean.name}`)
  closeEditor()
  changed()
}
