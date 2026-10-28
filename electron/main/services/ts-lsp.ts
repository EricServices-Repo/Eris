import { languageCapabilities } from '../../../src/shared/ide-capabilities'
import { pathToFileURL } from 'url'
import { logError, logInfo } from './logger'
import { languageServerFilePath, typescriptLanguageServerLaunch } from './lsp-paths'
import { realpathAllowMissing } from './workspace-fs'
import { LspSession } from './lsp-session'

export type LspDiagnostic = {
  path: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string
}

type DiagnosticsHandler = (items: LspDiagnostic[]) => void

let session: LspSession | null = null
let configuredRoot: string | null | undefined
let starting: { session: LspSession; promise: Promise<boolean> } | null = null
const openDocs = new Map<string, { version: number; languageId: string }>()
const diagnosticsHandlers = new Set<DiagnosticsHandler>()

function severityFromLsp(n: number | undefined): 'error' | 'warning' | 'info' {
  if (n === 1) return 'error'
  if (n === 2) return 'warning'
  return 'info'
}

function uriFor(filePath: string): string {
  return pathToFileURL(filePath).href
}

function pathFromUri(uri: string): string {
  return languageServerFilePath(uri)
}

export function configureTsLspRoot(root: string | null): void {
  const canonical = root === null ? null : realpathAllowMissing(root)
  if (canonical === configuredRoot) return
  configuredRoot = canonical
  const previous = session
  session = null
  starting = null
  openDocs.clear()
  if (previous) void previous.dispose()
}

async function ensureServer(root: string): Promise<boolean> {
  root = realpathAllowMissing(root)
  if (configuredRoot !== undefined && configuredRoot !== root) return false
  if (session?.root === root && session.active)
    return starting?.session === session ? starting.promise : true
  const previous = session
  session = null
  openDocs.clear()
  if (previous) void previous.dispose()
  let candidate: LspSession
  try {
    candidate = new LspSession(
      root,
      root,
      typescriptLanguageServerLaunch(root),
      () => session === candidate,
      () => {
        if (session === candidate) {
          session = null
          openDocs.clear()
        }
      }
    )
  } catch (error) {
    logError('Failed to launch TypeScript language server', { error: String(error) })
    return false
  }
  session = candidate
  candidate.connection.onNotification(
    'textDocument/publishDiagnostics',
    (params: { uri: string; version?: number; diagnostics: LspWireDiagnostic[] }) => {
      if (!candidate.active) return
      const path = pathFromUri(params.uri),
        doc = openDocs.get(path)
      if (!doc || (params.version !== undefined && params.version !== doc.version)) return
      const items: LspDiagnostic[] = (params.diagnostics || []).map((d) => ({
        path,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        endLine: (d.range?.end?.line ?? 0) + 1,
        endColumn: (d.range?.end?.character ?? 0) + 1,
        severity: severityFromLsp(d.severity),
        message: d.message,
        source: d.source || 'tsserver'
      }))
      for (const handler of diagnosticsHandlers) {
        try {
          handler(items)
        } catch {
          /* observer */
        }
      }
    }
  )
  candidate.listen()
  const promise = (async () => {
    try {
      await candidate.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: uriFor(root),
          rootPath: root,
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: { linkSupport: true },
              references: {},
              completion: { completionItem: { snippetSupport: false } },
              publishDiagnostics: {}
            },
            workspace: { workspaceFolders: true }
          },
          workspaceFolders: [{ uri: uriFor(root), name: 'workspace' }],
          initializationOptions: { preferences: { includeCompletionsForModuleExports: true } }
        },
        15000
      )
      if (!candidate.active) return false
      candidate.notify('initialized', {})
      logInfo('TypeScript language server ready', { root })
      return true
    } catch (error) {
      if (session === candidate) {
        session = null
        openDocs.clear()
      }
      await candidate.dispose(false)
      logError('TypeScript language server initialization failed', { error: String(error) })
      return false
    }
  })()
  const pending = { session: candidate, promise }
  starting = pending
  try {
    return await promise
  } finally {
    if (starting === pending) starting = null
  }
}
interface LspWireDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  message: string
  source?: string
}

export function onLspDiagnostics(handler: DiagnosticsHandler): () => void {
  diagnosticsHandlers.add(handler)
  return () => diagnosticsHandlers.delete(handler)
}

export async function disposeTsLsp(): Promise<void> {
  const previous = session
  session = null
  starting = null
  openDocs.clear()
  await previous?.dispose()
}

async function requestDocument(
  server: LspSession,
  filePath: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const version = openDocs.get(filePath)?.version
  const result = await server.request(method, params)
  if (!server.active || openDocs.get(filePath)?.version !== version)
    throw new Error('Stale document response')
  return result
}

function languageIdFor(language: string, filePath: string): string {
  const lang = (language || '').toLowerCase()
  if (lang === 'typescript' || lang === 'typescriptreact') return lang
  if (lang === 'javascript' || lang === 'javascriptreact') return lang
  if (filePath.endsWith('.tsx')) return 'typescriptreact'
  if (filePath.endsWith('.ts')) return 'typescript'
  if (filePath.endsWith('.jsx')) return 'javascriptreact'
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return 'javascript'
  }
  return lang || 'plaintext'
}

export function isTsLike(language: string, filePath: string): boolean {
  const id = languageIdFor(language, filePath)
  return (
    id === 'typescript' ||
    id === 'typescriptreact' ||
    id === 'javascript' ||
    id === 'javascriptreact'
  )
}

export async function lspDidOpen(
  root: string,
  filePath: string,
  language: string,
  text: string
): Promise<void> {
  if (!isTsLike(language, filePath)) return
  if (!(await ensureServer(root))) return
  const connection = session
  if (!connection || !connection.active || connection.root !== realpathAllowMissing(root)) return
  if (openDocs.has(filePath)) {
    await lspDidChange(root, filePath, language, text)
    return
  }
  const languageId = languageIdFor(language, filePath)
  const version = 1
  openDocs.set(filePath, { version, languageId })
  connection.notify('textDocument/didOpen', {
    textDocument: {
      uri: uriFor(filePath),
      languageId,
      version,
      text
    }
  })
}

/** Open a disk-backed document for agent queries without replacing an editor buffer. */
export async function lspEnsureOpen(
  root: string,
  filePath: string,
  language: string,
  text: string
): Promise<boolean> {
  if (!isTsLike(language, filePath)) return false
  if (!(await ensureServer(root))) return false
  const connection = session
  if (!connection || !connection.active || connection.root !== realpathAllowMissing(root))
    return false
  if (openDocs.has(filePath)) return true
  const languageId = languageIdFor(language, filePath)
  openDocs.set(filePath, { version: 1, languageId })
  connection.notify('textDocument/didOpen', {
    textDocument: { uri: uriFor(filePath), languageId, version: 1, text }
  })
  return true
}

export async function lspDidChange(
  root: string,
  filePath: string,
  language: string,
  text: string
): Promise<void> {
  if (!isTsLike(language, filePath)) return
  if (!(await ensureServer(root))) return
  const connection = session
  if (!connection || !connection.active || connection.root !== realpathAllowMissing(root)) return
  const prev = openDocs.get(filePath)
  if (!prev) {
    await lspDidOpen(root, filePath, language, text)
    return
  }
  const version = prev.version + 1
  openDocs.set(filePath, { ...prev, version })
  connection.notify('textDocument/didChange', {
    textDocument: { uri: uriFor(filePath), version },
    contentChanges: [{ text }]
  })
}

export async function lspDidClose(filePath: string): Promise<void> {
  const connection = session
  if (!connection || !connection.active || !openDocs.has(filePath)) return
  openDocs.delete(filePath)
  connection.notify('textDocument/didClose', {
    textDocument: { uri: uriFor(filePath) }
  })
}

export async function lspHover(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{ ok: boolean; contents: string }> {
  const ready = await ensureServer(root)
  const connection = session
  if (
    !ready ||
    !connection ||
    !connection.active ||
    connection.root !== realpathAllowMissing(root)
  ) {
    return { ok: false, contents: '' }
  }
  try {
    const result = (await requestDocument(connection, filePath, 'textDocument/hover', {
      textDocument: { uri: uriFor(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
    })) as { contents?: unknown } | null
    if (!result?.contents) return { ok: true, contents: '' }
    return { ok: true, contents: formatMarkup(result.contents) }
  } catch {
    return { ok: false, contents: '' }
  }
}

export async function lspDefinition(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{
  ok: boolean
  locations: Array<{ path: string; line: number; name: string; kind: string }>
}> {
  const ready = await ensureServer(root)
  const connection = session
  if (
    !ready ||
    !connection ||
    !connection.active ||
    connection.root !== realpathAllowMissing(root)
  ) {
    return { ok: false, locations: [] }
  }
  try {
    const result = (await requestDocument(connection, filePath, 'textDocument/definition', {
      textDocument: { uri: uriFor(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
    })) as
      | { uri: string; range: { start: { line: number; character: number } } }
      | Array<{ uri: string; range: { start: { line: number; character: number } } }>
      | null

    const list = !result ? [] : Array.isArray(result) ? result : [result]
    return {
      ok: true,
      locations: list.map((loc) => ({
        path: pathFromUri(loc.uri),
        line: (loc.range?.start?.line ?? 0) + 1,
        name: '',
        kind: 'definition'
      }))
    }
  } catch {
    return { ok: false, locations: [] }
  }
}

export async function lspReferences(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{ ok: boolean; locations: Array<{ path: string; line: number }> }> {
  const ready = await ensureServer(root)
  const connection = session
  if (!ready || !connection || !connection.active || connection.root !== realpathAllowMissing(root))
    return { ok: false, locations: [] }
  try {
    const result = (await requestDocument(connection, filePath, 'textDocument/references', {
      textDocument: { uri: uriFor(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      context: { includeDeclaration: true }
    })) as Array<{ uri: string; range: { start: { line: number } } }> | null
    return {
      ok: true,
      locations: (result || []).slice(0, 100).map((loc) => ({
        path: pathFromUri(loc.uri),
        line: (loc.range?.start?.line ?? 0) + 1
      }))
    }
  } catch {
    return { ok: false, locations: [] }
  }
}

export async function lspCompletion(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{ ok: boolean; items: Array<{ label: string; detail?: string; insertText?: string }> }> {
  const ready = await ensureServer(root)
  const connection = session
  if (
    !ready ||
    !connection ||
    !connection.active ||
    connection.root !== realpathAllowMissing(root)
  ) {
    return { ok: false, items: [] }
  }
  try {
    const result = (await requestDocument(connection, filePath, 'textDocument/completion', {
      textDocument: { uri: uriFor(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
    })) as
      | { items?: Array<{ label: string; detail?: string; insertText?: string }> }
      | Array<{ label: string; detail?: string; insertText?: string }>
      | null

    const items = !result ? [] : Array.isArray(result) ? result : result.items || []
    return {
      ok: true,
      items: items.slice(0, 40).map((i) => ({
        label: i.label,
        detail: i.detail,
        insertText: i.insertText
      }))
    }
  } catch {
    return { ok: false, items: [] }
  }
}

function formatMarkup(contents: unknown): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === 'string' ? c : formatMarkup(c)))
      .filter(Boolean)
      .join('\n\n')
  }
  if (contents && typeof contents === 'object') {
    const obj = contents as { value?: string; language?: string; kind?: string }
    if (typeof obj.value === 'string') {
      if (obj.language) return '```' + obj.language + '\n' + obj.value + '\n```'
      return obj.value
    }
  }
  return ''
}

export async function tsLanguageCapabilities(root: string, filePath: string) {
  const ready = await ensureServer(root)
  return languageCapabilities(
    'typescript-language-server',
    session?.capabilities,
    !!ready && !!session?.active && openDocs.has(filePath)
  )
}
export async function tsEditRequest(
  root: string,
  filePath: string,
  method: string,
  params: unknown
) {
  if (!(await ensureServer(root)) || !session?.active || !openDocs.has(filePath))
    throw new Error('Language server/document unavailable')
  const captured = session
  const version = openDocs.get(filePath)!.version
  return { response: await requestDocument(captured, filePath, method, params), version }
}
