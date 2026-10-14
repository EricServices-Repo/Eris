import { setDefaultResultOrder } from 'dns'
import { copyFileSync, renameSync, unlinkSync } from 'fs'
import { Readable } from 'stream'
import { logWarn } from './logger'

/** No data for this long → abort (large HF downloads stall often on Windows). */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000

/** Throttle UI progress events so the renderer is not flooded per chunk. */
export const DOWNLOAD_PROGRESS_THROTTLE_MS = 250

export type DownloadPhase = 'downloading' | 'verifying' | 'finalizing'

/**
 * Resolve a stable byte total for progress bars.
 * Prefer Hugging Face `x-linked-size`, then Content-Length when it agrees with
 * approxBytes; otherwise use the catalog estimate (avoids ~90% stalls when the
 * estimate is high, and jumps when CL is wrong/compressed).
 */
export function resolveDownloadTotal(
  headers: Headers,
  approxBytes: number
): { total: number; source: 'x-linked-size' | 'content-length' | 'approx' } {
  const linked = Number(headers.get('x-linked-size') || 0)
  if (Number.isFinite(linked) && linked > 0) {
    return { total: linked, source: 'x-linked-size' }
  }

  const encoding = (headers.get('content-encoding') || '').toLowerCase().trim()
  const compressed = Boolean(encoding && encoding !== 'identity')
  const contentLength = Number(headers.get('content-length') || 0)
  if (!compressed && Number.isFinite(contentLength) && contentLength > 0) {
    if (approxBytes <= 0) return { total: contentLength, source: 'content-length' }
    const ratio = contentLength / approxBytes
    if (ratio >= 0.85 && ratio <= 1.2) {
      return { total: contentLength, source: 'content-length' }
    }
  }

  if (approxBytes > 0) return { total: approxBytes, source: 'approx' }
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return { total: contentLength, source: 'content-length' }
  }
  return { total: 0, source: 'approx' }
}

export function createThrottledProgress(emit: () => void, intervalMs = DOWNLOAD_PROGRESS_THROTTLE_MS) {
  let last = 0
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    last = Date.now()
    pending = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    emit()
  }
  return {
    ping() {
      const now = Date.now()
      if (now - last >= intervalMs) {
        run()
        return
      }
      pending = true
      if (!timer) {
        timer = setTimeout(run, intervalMs - (now - last))
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      run()
    }
  }
}

/** Destroy the stream if no chunks arrive for `idleMs`. */
export function attachIdleTimeout(
  stream: Readable,
  idleMs: number,
  onTimeout: (err: Error) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const arm = () => {
    clear()
    timer = setTimeout(() => {
      const err = new Error(
        `Download stalled — no data for ${Math.round(idleMs / 1000)}s. Check network/VPN and retry.`
      )
      onTimeout(err)
      if (!stream.destroyed) stream.destroy(err)
    }, idleMs)
  }
  arm()
  stream.on('data', arm)
  stream.on('end', clear)
  stream.on('close', clear)
  stream.on('error', clear)
  return clear
}

/**
 * Atomically publish a finished download. Retries rename on Windows AV locks;
 * falls back to copy + delete.
 */
export async function publishDownloadedFile(partial: string, target: string): Promise<void> {
  try {
    unlinkSync(target)
  } catch {
    // target may not exist yet
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      renameSync(partial, target)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
  }

  try {
    copyFileSync(partial, target)
    try {
      unlinkSync(partial)
    } catch {
      // leave orphan partial if delete fails; target is good
    }
    return
  } catch (copyErr) {
    throw lastErr instanceof Error ? lastErr : copyErr
  }
}

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
    // Avoid compressed transfer sizes that disagree with Content-Length / progress.
    'Accept-Encoding': 'identity',
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
