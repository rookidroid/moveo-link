// HTTP client for the robot's REST API. Runs in the main process: the
// firmware's POST replies carry no CORS headers, so the renderer cannot call
// the robot directly.

import type { ApiResult } from '../shared/types'

const TIMEOUT_MS = 8000
// Only plain API paths, e.g. /status or /movepose
const PATH_RE = /^\/[a-z]+$/

export function normalizeHost(host: string): string {
  const h = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return h || '192.168.4.1'
}

export async function robotRequest(host: string, path: string, body?: unknown): Promise<ApiResult> {
  if (typeof path !== 'string' || !PATH_RE.test(path)) {
    return { ok: false, status: 0, error: 'invalid path' }
  }
  const url = `http://${normalizeHost(host)}${path}`
  try {
    const r = await fetch(url, body === undefined
      ? { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        })
    const text = await r.text()
    let data: any = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    if (!r.ok) return { ok: false, status: r.status, data, error: data.error || `HTTP ${r.status}` }
    return { ok: true, status: r.status, data }
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return { ok: false, status: 0, error: timedOut ? 'Request timed out' : 'Robot unreachable' }
  }
}
