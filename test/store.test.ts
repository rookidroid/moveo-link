import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/main/store'
import { normalizeHost } from '../src/main/robot'
import type { Library } from '../src/shared/types'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'moveo-link-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('JsonStore', () => {
  it('starts empty and round-trips the library', async () => {
    const store = new JsonStore(tmp())
    expect(await store.loadLibrary()).toEqual({ version: 1, positions: [], sequences: [] })
    const lib: Library = {
      version: 1,
      positions: [{ id: 'p', name: 'P1', kind: 'joints', joints: { unit: 'deg', v: [1, 2, 3, 4, 5] }, gripper: 1500, updatedAt: 1 }],
      sequences: [{ id: 's', name: 'S', repeat: 2, steps: [{ id: 'x', type: 'wait', ms: 100 }], updatedAt: 1 }]
    }
    await store.saveLibrary(lib)
    expect(await store.loadLibrary()).toEqual(lib)
  })

  it('survives a corrupt file', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'library.json'), '{nope')
    expect((await new JsonStore(dir).loadLibrary()).positions).toEqual([])
  })

  it('keeps settings with a default host', async () => {
    const store = new JsonStore(tmp())
    expect((await store.loadSettings()).host).toBe('192.168.4.1')
    await store.saveSettings({ host: 'localhost:8080' })
    expect((await store.loadSettings()).host).toBe('localhost:8080')
  })
})

describe('normalizeHost', () => {
  it('strips scheme and slashes', () => {
    expect(normalizeHost(' http://192.168.4.1/ ')).toBe('192.168.4.1')
    expect(normalizeHost('')).toBe('192.168.4.1')
  })
})

describe('library import', () => {
  beforeAll(() => {
    ;(globalThis as any).window = { moveo: { library: { save: async () => {} } } }
  })

  it('merges files and remaps clashing ids', async () => {
    const { lib, importData } = await import('../src/renderer/lib/library')
    lib.positions.push({ id: 'p1', name: 'Mine', kind: 'joints', joints: { unit: 'deg', v: [0, 0, 0, 0, 0] }, gripper: null, updatedAt: 0 })
    const r = importData({
      kind: 'moveo-link',
      positions: [{ id: 'p1', name: 'Theirs', kind: 'pose', pose: { x: 1, y: 2, z: 3, pitch: 0 }, gripper: null, updatedAt: 0 }],
      sequences: [{ id: 's1', name: 'Seq', repeat: 1, updatedAt: 0, steps: [{ id: 'a', type: 'move', positionId: 'p1', speed: 50, dwellMs: 0 }] }]
    })
    expect(r).toEqual({ positions: 1, sequences: 1 })
    expect(lib.positions).toHaveLength(2)
    const theirs = lib.positions.find(p => p.name === 'Theirs')!
    expect(theirs.id).not.toBe('p1')
    const step = lib.sequences[0].steps[0]
    expect(step.type === 'move' && step.positionId).toBe(theirs.id)
    expect(importData({ hello: 1 })).toBe('Not a Moveo Link file')
  })
})
