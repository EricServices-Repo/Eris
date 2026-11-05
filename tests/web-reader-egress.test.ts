import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
})

describe('web reader egress', () => {
  it('blocks private IPv6 forms that the hostname check missed', async () => {
    const { publicHttpsUrl } = await import('../electron/main/services/web-search')
    for (const url of [
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:a9fe:a9fe]/latest/meta-data',
      'https://[fd00::1]/',
      'https://[fc12:3456::1]/',
      'https://[fe80::1]/',
      'https://[::]/',
      'https://[64:ff9b::7f00:1]/'
    ])
      expect(() => publicHttpsUrl(url), url).toThrow(/private|Local/)
    expect(publicHttpsUrl('https://[2606:4700::1111]/')).toBe('https://[2606:4700::1111]/')
  })

  it('applies the public-https check to every request, not only the first URL', async () => {
    const { webReaderRequestAllowed } = await import('../electron/main/services/web-search')
    expect(webReaderRequestAllowed('https://example.com/app.js')).toBe(true)
    expect(webReaderRequestAllowed('data:image/png;base64,AAAA')).toBe(true)
    for (const url of [
      'http://127.0.0.1:3000/api',
      'https://localhost/admin',
      'http://169.254.169.254/latest/meta-data/',
      'https://192.168.0.10/',
      'http://example.com/',
      'file:///etc/passwd',
      'ws://localhost:9229/'
    ])
      expect(webReaderRequestAllowed(url), url).toBe(false)
  })

  it('opens pages in a guarded session that filters requests, redirects and popups', async () => {
    let filter: ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null =
      null
    let deniedPermission = false
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const opened: { handler?: () => { action: string } } = {}
    const readerSession = {
      webRequest: { onBeforeRequest: (fn: typeof filter) => (filter = fn) },
      setPermissionRequestHandler: (
        fn: (c: unknown, p: string, cb: (ok: boolean) => void) => void
      ) => fn(null, 'media', (ok) => (deniedPermission = !ok))
    }
    let options: { webPreferences?: { session?: unknown } } = {}
    class FakeWindow {
      constructor(o: typeof options) {
        options = o
      }
      isDestroyed = () => false
      destroy = () => undefined
      loadURL = async () => handlers.get('did-finish-load')?.()
      webContents = {
        setWindowOpenHandler: (fn: () => { action: string }) => (opened.handler = fn),
        on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
        once: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
        executeJavaScript: async () => ({ title: 'Example', text: 'Hello' })
      }
    }
    vi.doMock('electron', () => ({
      BrowserWindow: FakeWindow,
      session: {
        fromPartition: (name: string) => (name === 'eris-web-reader' ? readerSession : null)
      }
    }))
    const { openWebPage } = await import('../electron/main/services/web-search')

    expect(await openWebPage('https://example.com')).toContain('Hello')
    expect(options.webPreferences?.session).toBe(readerSession)
    expect(opened.handler?.()).toEqual({ action: 'deny' })
    expect(deniedPermission).toBe(true)

    const decide = (url: string) => {
      let cancel: boolean | undefined
      filter!({ url }, (r) => (cancel = r.cancel))
      return cancel
    }
    expect(decide('https://example.com/style.css')).toBe(false)
    expect(decide('http://127.0.0.1:8080/')).toBe(true)

    for (const event of ['will-redirect', 'will-navigate']) {
      const blocked = { preventDefault: vi.fn() }
      handlers.get(event)!(blocked, 'http://169.254.169.254/')
      expect(blocked.preventDefault).toHaveBeenCalled()
      const allowed = { preventDefault: vi.fn() }
      handlers.get(event)!(allowed, 'https://example.org/next')
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }
  })
})
