import { setDefaultResultOrder } from 'dns'
import { Readable } from 'stream'
import { logWarn } from './logger'

/** Prefer IPv4 for Node/undici — Windows Happy Eyeballs often yields opaque "fetch failed". */
try {
  setDefaultResultOrder('ipv4first')
} catch {
  // ignore on older runtimes
}

export type DownloadResponse = {
  ok: boolean
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  /** Which stack performed the request */
  via: 'electron-net' | 'node-fetch'
}

function causeChain(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      if (cur.message) parts.push(cur.message)
      const code = (cur as NodeJS.ErrnoException).code
      if (code && !parts.some((p) => p.includes(String(code)))) parts.push(String(code))
      cur = (cur as Error & { cause?: unknown }).cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return [...new Set(parts)].join(' — ')
}

export function formatDownloadNetworkError(err: unknown, url: string): Error {
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // keep raw
  }
  const detail = causeChain(err) || 'network error'
  return new Error(
    `Could not reach ${host} (${detail}). Check internet, VPN/proxy, and firewall. ` +
      `On Windows, try disabling IPv6-only VPN modes or allow Eris through the firewall.`
  )
}

/**
 * Fetch a large binary using Electron's Chromium network stack when available
 * (system proxy + DNS work better on Windows than Node undici fetch).
 * Falls back to global fetch.
 */
export async function downloadFetch(
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> } = {}
): Promise<DownloadResponse> {
  const headers = {
    'User-Agent': 'Eris-IDE/0.2 (desktop; model-download)',
    Accept: 'application/octet-stream,*/*',
    ...init.headers
  }

  // Prefer Chromium net (available after app ready in the main process).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net, app } = require('electron') as {
      net: { fetch: typeof fetch; isOnline?: () => boolean }
      app: { isReady: () => boolean }
    }
    if (app.isReady() && typeof net.fetch === 'function') {
      if (typeof net.isOnline === 'function' && !net.isOnline()) {
        throw new Error('Device appears offline')
      }
      const res = await net.fetch(url, {
        signal: init.signal,
        redirect: 'follow',
        headers
      })
      return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        body: res.body,
        via: 'electron-net'
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/offline/i.test(msg)) throw err
    logWarn('electron.net.fetch failed; falling back to Node fetch', {
      url: url.slice(0, 120),
      error: causeChain(err)
    })
  }

  try {
    const res = await fetch(url, {
      signal: init.signal,
      redirect: 'follow',
      headers
    })
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body: res.body,
      via: 'node-fetch'
    }
  } catch (err) {
    throw formatDownloadNetworkError(err, url)
  }
}

export function bodyToNodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as import('stream/web').ReadableStream)
}
