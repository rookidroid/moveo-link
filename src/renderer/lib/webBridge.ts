// Browser stand-in for the Electron preload bridge, used by `npm run web`
// (UI development in a plain browser). Robot calls go through the Vite dev
// proxy at /robot; the library lives in localStorage.

import { emptyLibrary, type ApiResult, type Library, type MoveoBridge } from '@shared/types'

export function installWebBridge() {
  if (window.moveo) return
  const LIB = 'moveo.web.library'
  const bridge: MoveoBridge = {
    async api(path, body): Promise<ApiResult> {
      try {
        const r = await fetch('/robot' + path, body === undefined
          ? { signal: AbortSignal.timeout(8000) }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
        const data = await r.json().catch(() => ({}))
        if (r.status >= 500 && !data.error) return { ok: false, status: 0, error: 'Robot unreachable' }
        return r.ok ? { ok: true, status: r.status, data } : { ok: false, status: r.status, data, error: data.error || `HTTP ${r.status}` }
      } catch {
        return { ok: false, status: 0, error: 'Robot unreachable' }
      }
    },
    library: {
      async load(): Promise<Library> {
        try { return { ...emptyLibrary(), ...JSON.parse(localStorage.getItem(LIB) || '{}') } } catch { return emptyLibrary() }
      },
      async save(lib) { localStorage.setItem(LIB, JSON.stringify(lib)) },
      async exportJson(name, data) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
        a.download = name + '.json'
        a.click()
        return true
      },
      importJson() {
        return new Promise(resolve => {
          const inp = document.createElement('input')
          inp.type = 'file'
          inp.accept = '.json,application/json'
          inp.onchange = async () => {
            const f = inp.files?.[0]
            if (!f) return resolve(null)
            try { resolve(JSON.parse(await f.text())) } catch { resolve({ error: 'Not a valid JSON file' }) }
          }
          inp.click()
        })
      }
    },
    settings: {
      async get() { return { host: 'dev proxy' } },
      async set() { return { host: 'dev proxy' } }
    }
  }
  window.moveo = bridge
}
