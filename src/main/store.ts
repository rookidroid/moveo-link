// Library (positions + sequences) and settings, stored as JSON files in the
// app's user-data folder.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_HOST, emptyLibrary, type Library, type Settings } from '../shared/types'

export class JsonStore {
  constructor(private dir: string) {}

  private file(name: string) { return join(this.dir, name) }

  private async read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T
    } catch {
      return fallback
    }
  }

  // Write to a temp file and rename, so a crash never leaves half a file
  private async write(name: string, data: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = this.file(name + '.tmp')
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.file(name))
  }

  async loadLibrary(): Promise<Library> {
    const lib = await this.read<Partial<Library>>('library.json', emptyLibrary())
    return {
      version: 1,
      positions: Array.isArray(lib.positions) ? lib.positions : [],
      sequences: Array.isArray(lib.sequences) ? lib.sequences : []
    }
  }

  saveLibrary(lib: Library): Promise<void> {
    return this.write('library.json', lib)
  }

  async loadSettings(): Promise<Settings> {
    const s = await this.read<Partial<Settings>>('settings.json', {})
    return { host: typeof s.host === 'string' && s.host ? s.host : DEFAULT_HOST }
  }

  async saveSettings(s: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.loadSettings()), ...s }
    await this.write('settings.json', next)
    return next
  }
}
