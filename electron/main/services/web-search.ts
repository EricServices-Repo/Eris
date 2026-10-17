const PAGE_TEXT_LIMIT = 12_000
const SEARCH_RESULT_LIMIT = 8
const LOAD_TIMEOUT_MS = 20_000

const BLOCKED_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local|.*\.internal|metadata\.google\.internal)$/i
const PRIVATE_IP =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.|127\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

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
  if (!host || BLOCKED_HOST.test(host) || PRIVATE_IP.test(host) || host === '::1') {
    throw new Error('Local and private addresses are blocked.')
  }
  return url.toString()
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
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

export async function searchWeb(query: string, signal?: AbortSignal): Promise<string> {
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
      title: String(row.title || url).replace(/\s+/g, ' ').trim(),
      url,
      snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim()
    })
  }
  return formatSearchHits(query, hits)
}

export async function openWebPage(rawUrl: string, signal?: AbortSignal): Promise<string> {
  const url = publicHttpsUrl(rawUrl)
  const page = (await readBrowserPage(url, signal, PAGE_EXTRACT)) as {
    title?: string
    text?: string
  }
  return formatOpenedPage(url, String(page?.title || ''), String(page?.text || ''))
}
