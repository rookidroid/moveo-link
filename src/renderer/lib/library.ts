// In-memory library of positions and sequences, saved to disk through the
// main process (debounced) after every change.

import { emptyLibrary, uid, type Library, type Position, type Sequence } from '@shared/types'
import { emit } from './core'

export const lib: Library = emptyLibrary()
let saveTimer: ReturnType<typeof setTimeout> | undefined

export async function loadLibrary() {
  Object.assign(lib, await window.movens.library.load())
  emit('library', undefined)
}

/** Call after mutating lib; persists shortly after and notifies the views */
export function changed() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => window.movens.library.save(structuredClone(lib)), 300)
  emit('library', undefined)
}

export const findPosition = (id: string) => lib.positions.find(p => p.id === id)
export const findSequence = (id: string) => lib.sequences.find(s => s.id === id)

/** Next free default name: P1, P2, ... */
export function nextName(prefix: string, names: string[]): string {
  let n = 1
  while (names.includes(prefix + n)) n++
  return prefix + n
}

/** Sequences whose steps use the position */
export const sequencesUsing = (posId: string) =>
  lib.sequences.filter(s => s.steps.some(st => st.type === 'move' && st.positionId === posId))

// ── Import / export ──────────────────────────────────────────────────────────
// File format: {kind:'movens-link', positions, sequences}. A single exported
// sequence carries the positions it uses. Files exported before the rename
// say 'moveo-link'.

export function exportData(seq?: Sequence) {
  if (!seq) return { kind: 'movens-link', version: 1, positions: lib.positions, sequences: lib.sequences }
  const ids = new Set(seq.steps.flatMap(s => (s.type === 'move' ? [s.positionId] : [])))
  return { kind: 'movens-link', version: 1, positions: lib.positions.filter(p => ids.has(p.id)), sequences: [seq] }
}

const isPosition = (p: any): p is Position =>
  p && typeof p.id === 'string' && typeof p.name === 'string' && (p.kind === 'joints' || p.kind === 'pose')
const isSequence = (s: any): s is Sequence =>
  s && typeof s.id === 'string' && typeof s.name === 'string' && Array.isArray(s.steps)

/** Merge imported data; clashing ids get new ones. Returns counts or an error. */
export function importData(data: any): { positions: number; sequences: number } | string {
  if (!data || data.error) return data?.error || 'Nothing to import'
  if (data.kind !== 'movens-link' && data.kind !== 'moveo-link') return 'Not a Movens Link file'
  const positions: Position[] = (data.positions || []).filter(isPosition)
  const sequences: Sequence[] = (data.sequences || []).filter(isSequence)
  const remap = new Map<string, string>()
  const posIds = new Set(lib.positions.map(p => p.id))
  for (const p of positions) {
    const copy = structuredClone(p)
    if (posIds.has(copy.id)) { remap.set(copy.id, uid()); copy.id = remap.get(p.id)! }
    lib.positions.push(copy)
  }
  const seqIds = new Set(lib.sequences.map(s => s.id))
  for (const s of sequences) {
    const copy = structuredClone(s)
    if (seqIds.has(copy.id)) copy.id = uid()
    for (const st of copy.steps) {
      if (!st.id) st.id = uid()
      if (st.type === 'move' && remap.has(st.positionId)) st.positionId = remap.get(st.positionId)!
    }
    lib.sequences.push(copy)
  }
  changed()
  return { positions: positions.length, sequences: sequences.length }
}
