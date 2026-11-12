import { activeDiagnosticsScope } from './model-transport'

const PAGE_TEXT_LIMIT = 12_000
const SEARCH_RESULT_LIMIT = 8
const LOAD_TIMEOUT_MS = 20_000

const BLOCKED_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local|.*\.internal|metadata\.google\.internal)$/i
const PRIVATE_IP =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.|127\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

/** In-memory session for the hidden reader: no shared cookies, and its own request filter. */
const WEB_READER_PARTITION = 'eris-web-reader'

/** IPv6 loopback, unspecified, unique-local, link-local, IPv4-mapped and NAT64 addresses. */
function privateIpv6(host: string): boolean {
  if (!host.startsWith('[')) return false
  const ip = host.slice(1, -1).toLowerCase()
  return (
    ip === '::' ||
    ip === '::1' ||
    /^f[cd][0-9a-f]{0,2}:/.test(ip) ||
    /^fe[89ab][0-9a-f]?:/.test(ip) ||
    ip.startsWith('::ffff:') ||
    ip.startsWith('64:ff9b:')
  )
}

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export function publicHttpsUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('That is not a web address.')
  }
  if (url.protocol !== 'https:') throw new Error('Only https pages can be opened.')
  if (url.username || url.password) {
    throw new Error('Addresses with a username or password are blocked.')
  }
  const host = url.hostname.replace(/\.$/, '')
  if (!host || BLOCKED_HOST.test(host) || PRIVATE_IP.test(host) || privateIpv6(host)) {
    throw new Error('Local and private addresses are blocked.')
  }
  return url.toString()
}

/**
 * Every request the hidden reader makes (redirects, frames, scripts, fetch/XHR from the
 * page) must pass the same public-https check as the URL the agent asked for. Checking
 * only the first URL let a page redirect to, or script requests against, localhost, the
 * LAN or a cloud metadata address and hand the response text back to the model.
 */
export function webReaderRequestAllowed(raw: string): boolean {
  if (/^(?:data|blob):/i.test(raw) || raw === 'about:blank') return true
  try {
    publicHttpsUrl(raw)
    return true
  } catch {
    return false
  }
}

let readerSessionGuarded = false

async function guardedReaderSession() {
  const { session } = await import('electron')
  const reader = session.fromPartition(WEB_READER_PARTITION)
  if (!readerSessionGuarded) {
    reader.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !webReaderRequestAllowed(details.url) })
    )
    reader.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    readerSessionGuarded = true
  }
  return reader
}

export function searchPageUrl(query: string): string {
  const q = query.trim()
  if (!q) throw new Error('query is required')
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q.slice(0, 300))}`
}

export function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    if (target) return target
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
  } catch {
    /* keep the original href */
  }
  return href
}

export function formatSearchHits(query: string, hits: WebSearchHit[]): string {
  const lines = [`Searched the web for “${query.trim()}”.`, '']
  if (hits.length === 0) {
    lines.push('No results.')
    return lines.join('\n')
  }
  hits.slice(0, SEARCH_RESULT_LIMIT).forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`)
    lines.push(`   ${hit.url}`)
    if (hit.snippet) lines.push(`   ${hit.snippet}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}

export function formatOpenedPage(url: string, title: string, text: string): string {
  const trimmed = text.trim()
  const body = trimmed.slice(0, PAGE_TEXT_LIMIT)
  const clipped = trimmed.length > PAGE_TEXT_LIMIT ? '\n\n[page text truncated]' : ''
  return [`Opened ${url}`, title ? `Title: ${title}` : '', '', body + clipped]
    .filter((line) => line !== '')
    .join('\n')
    .trim()
}

async function readBrowserPage(
  url: string,
  signal: AbortSignal | undefined,
  extract: string
): Promise<unknown> {
  const { BrowserWindow } = await import('electron')
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: await guardedReaderSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const refuseNavigation = (event: { preventDefault: () => void }, target: string) => {
    if (!webReaderRequestAllowed(target)) event.preventDefault()
  }
  win.webContents.on('will-navigate', refuseNavigation)
  win.webContents.on('will-redirect', refuseNavigation)
  const close = () => {
    if (!win.isDestroyed()) win.destroy()
  }
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        close()
        reject(new Error('The browser timed out.'))
      }, LOAD_TIMEOUT_MS)
      const fail = (error: Error) => {
        clearTimeout(timer)
        close()
        reject(error)
      }
      const onAbort = () => fail(new Error('Aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      win.webContents.once('did-fail-load', (_event, code, description) => {
        signal?.removeEventListener('abort', onAbort)
        fail(new Error(description || `The browser could not open the page (${code}).`))
      })
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        void win.webContents
          .executeJavaScript(extract, true)
          .then(resolve)
          .catch((err: unknown) =>
            fail(err instanceof Error ? err : new Error('The browser could not read the page.'))
          )
      })
      void win.loadURL(url)
    })
  } finally {
    close()
  }
}

const SEARCH_EXTRACT = `(() => {
  const rows = Array.from(document.querySelectorAll('.result, .web-result')).slice(0, 8)
  return rows.map((row) => {
    const link = row.querySelector('a.result__a, a.result__url, a')
    return {
      title: (link && link.textContent || '').trim(),
      href: link ? link.getAttribute('href') || '' : '',
      snippet: (row.querySelector('.result__snippet')?.textContent || '').trim()
    }
  }).filter((row) => row.title && row.href)
})()`

const PAGE_EXTRACT = `(() => ({
  title: document.title || '',
  text: document.body ? document.body.innerText : ''
}))()`

/** Diagnostics runs never contact the network for web lookups. */
function assertWebAllowed(detail: string): void {
  const diagnostics = activeDiagnosticsScope()
  if (!diagnostics) return
  diagnostics.onBlockedEffect('web', detail)
  throw new Error('Web access is disabled in diagnostics runs')
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<string> {
  assertWebAllowed(`search: ${query.slice(0, 200)}`)
  const page = searchPageUrl(query)
  const raw = (await readBrowserPage(page, signal, SEARCH_EXTRACT)) as Array<{
    title?: string
    href?: string
    snippet?: string
  }>
  const hits: WebSearchHit[] = []
  for (const row of Array.isArray(raw) ? raw : []) {
    const href = unwrapDuckDuckGoUrl(String(row.href || ''))
    let url = href
    try {
      url = publicHttpsUrl(href.startsWith('http://') ? href.replace(/^http:/, 'https:') : href)
    } catch {
      continue
    }
    hits.push({
      title: String(row.title || url)
        .replace(/\s+/g, ' ')
        .trim(),
      url,
      snippet: String(row.snippet || '')
        .replace(/\s+/g, ' ')
        .trim()
    })
  }
  return formatSearchHits(query, hits)
}

export async function openWebPage(rawUrl: string, signal?: AbortSignal): Promise<string> {
  assertWebAllowed(`open: ${rawUrl.slice(0, 200)}`)
  const url = publicHttpsUrl(rawUrl)
  const page = (await readBrowserPage(url, signal, PAGE_EXTRACT)) as {
    title?: string
    text?: string
  }
  return formatOpenedPage(url, String(page?.title || ''), String(page?.text || ''))
}

/** An explicitly named visual reference in a request to change the workspace. */
export function designReferenceUrl(text: string): string | undefined {
  if (!/\b(?:css|stylesheets?|design|layout|colou?rs?|palette|theme)\b/i.test(text)) return undefined
  const match = text.match(/\b(?:look like|match|based on|inspired by|reference|from)\s+(?:the (?:design|layout|colou?rs?|palette) (?:of|from)\s+)?(?:\[[^\]\n]*\]\()?((?:https:\/\/|www\.)[^\s<>"'`()[\]]+)/i)
  const address = match?.[1]?.replace(/[.,!?;:]+$/, '')
  return address && /^www\./i.test(address) ? `https://${address}` : address
}

const PALETTE_SELECTORS = ['body', 'header', 'nav', 'main', 'h1', 'a', 'button', 'footer']
const PALETTE_PROPERTIES = ['color', 'background-color', 'border-top-color']
const PALETTE_EXTRACT = `(() => ${JSON.stringify(PALETTE_SELECTORS)}.map(selector => {
  const element = document.querySelector(selector)
  if (!element) return []
  const styles = getComputedStyle(element)
  return ${JSON.stringify(PALETTE_PROPERTIES)}.map(property => styles.getPropertyValue(property))
}))()`

export function formatDesignPalette(url: string, computed: unknown): string {
  const rows = Array.isArray(computed) ? computed : []
  const palette = PALETTE_SELECTORS.flatMap((selector, row) => {
    const values: unknown[] = Array.isArray(rows[row]) ? rows[row] : []
    const colors = PALETTE_PROPERTIES.flatMap((property, index) => {
      const value = values[index]
      return typeof value === 'string' && /^rgba?\([\d., %/]{3,45}\)$/.test(value)
        ? [`${property}: ${value}`]
        : []
    })
    return colors.length ? [`${selector} { ${colors.join('; ')} }`] : []
  })
  if (!palette.length) throw new Error('The page did not expose any supported computed colors.')
  return [`Computed color samples from ${url}`, ...palette].join('\n')
}

export async function openWebDesignReference(rawUrl: string, signal?: AbortSignal): Promise<string> {
  assertWebAllowed(`design reference: ${rawUrl.slice(0, 200)}`)
  const url = publicHttpsUrl(rawUrl)
  signal?.throwIfAborted()
  const computed = await readBrowserPage(url, signal, PALETTE_EXTRACT)
  signal?.throwIfAborted()
  return formatDesignPalette(url, computed)
}
