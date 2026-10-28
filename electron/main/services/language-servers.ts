import { languageCapabilities } from '../../../src/shared/ide-capabilities'
import { tsLanguageCapabilities, tsEditRequest } from './ts-lsp'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
import { LspSession } from './lsp-session'
import { realpathAllowMissing } from './workspace-fs'
import type { AppSettings, LanguageServerConfig } from '../../../src/shared/settings-schema'
import { logError, logInfo } from './logger'
import { languageServerFilePath, languageServerLaunch } from './lsp-paths'
import {
  disposeTsLsp,
  configureTsLspRoot,
  isTsLike,
  lspCompletion as tsCompletion,
  lspDefinition as tsDefinition,
  lspDidChange as tsDidChange,
  lspDidClose as tsDidClose,
  lspDidOpen as tsDidOpen,
  lspHover as tsHover,
  lspEnsureOpen as tsEnsureOpen,
  lspReferences as tsReferences,
  onLspDiagnostics,
  type LspDiagnostic
} from './ts-lsp'

type ExtraSession = {
  id: string
  root: string
  key: string
  server: LspSession
  languageId: string
}
function keyFor(root: string, spec: LanguageServerConfig): string {
  return `${realpathAllowMissing(root)}:${createHash('sha256').update(JSON.stringify(spec)).digest('hex')}`
}
function sessionFor(root: string, spec: LanguageServerConfig) {
  return extras.get(keyFor(root, spec))
}
const extras = new Map<string, ExtraSession>()
const starting = new Map<string, Promise<boolean>>()
const openDocs = new Map<string, { version: number; languageId: string; serverId: string }>()
let servers: LanguageServerConfig[] = []
let workspaceRoot: string | null = null

export { onLspDiagnostics, type LspDiagnostic }

export function configureLanguageServers(settings: AppSettings, root: string | null): void {
  const nextRoot = root === null ? null : realpathAllowMissing(root)
  const next = settings.intelligence.languageServers.filter((s) => s.enabled && s.command)
  workspaceRoot = nextRoot
  servers = next
  configureTsLspRoot(nextRoot)
  const keep = new Set(nextRoot ? next.map((spec) => keyFor(nextRoot, spec)) : [])
  for (const key of extras.keys()) if (!keep.has(key)) void disposeExtra(key)
}

function uriFor(filePath: string): string {
  return pathToFileURL(filePath).href
}

function pathFromUri(uri: string): string {
  return languageServerFilePath(uri)
}

function severityFromLsp(n: number | undefined): 'error' | 'warning' | 'info' {
  if (n === 1) return 'error'
  if (n === 2) return 'warning'
  return 'info'
}

function matchServer(language: string, filePath: string): LanguageServerConfig | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const lang = language.toLowerCase()
  return (
    servers.find((s) => s.languageId.toLowerCase() === lang) ||
    servers.find((s) =>
      s.extensions.map((e) => e.replace(/^\./, '').toLowerCase()).includes(ext)
    ) ||
    null
  )
}

async function ensureExtra(root: string, spec: LanguageServerConfig): Promise<boolean> {
  root = realpathAllowMissing(root)
  if (workspaceRoot !== root || !servers.some((item) => keyFor(root, item) === keyFor(root, spec)))
    return false
  const key = keyFor(root, spec)
  const existing = extras.get(key)
  const inflight = starting.get(key)
  if (inflight) return inflight
  if (existing?.server.active) return true
  let session: ExtraSession
  try {
    const server = new LspSession(
      root,
      key,
      languageServerLaunch(spec.command, spec.args, root),
      () => extras.get(key) === session && workspaceRoot === root,
      () => {
        if (extras.get(key) === session) {
          extras.delete(key)
          clearDocs(key)
        }
      }
    )
    session = { id: spec.id, root, key, server, languageId: spec.languageId }
  } catch (error) {
    logError('Language server launch failed', { id: spec.id, error: String(error) })
    return false
  }
  extras.set(key, session)
  session.server.connection.onNotification(
    'textDocument/publishDiagnostics',
    (params: {
      uri: string
      version?: number
      diagnostics: Array<{
        range: {
          start: { line: number; character: number }
          end: { line: number; character: number }
        }
        severity?: number
        message: string
        source?: string
      }>
    }) => {
      if (!session.server.active) return
      const path = pathFromUri(params.uri),
        doc = openDocs.get(path)
      if (
        !doc ||
        doc.serverId !== key ||
        (params.version !== undefined && params.version !== doc.version)
      )
        return
      const items: LspDiagnostic[] = (params.diagnostics || []).map((d) => ({
        path,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        endLine: (d.range?.end?.line ?? 0) + 1,
        endColumn: (d.range?.end?.character ?? 0) + 1,
        severity: severityFromLsp(d.severity),
        message: d.message,
        source: d.source || spec.id
      }))
      notifyDiagnostics(items)
    }
  )
  session.server.listen()
  const promise = (async () => {
    try {
      await session.server.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: uriFor(root),
          rootPath: root,
          capabilities: {
            textDocument: {
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: { linkSupport: true },
              references: {},
              completion: { completionItem: { snippetSupport: false } },
              publishDiagnostics: {}
            },
            workspace: { workspaceFolders: true }
          },
          workspaceFolders: [{ uri: uriFor(root), name: 'workspace' }]
        },
        15000
      )
      if (!session.server.active) return false
      session.server.notify('initialized', {})
      logInfo('Language server ready', { id: spec.id, root, key })
      return true
    } catch (error) {
      if (extras.get(key) === session) {
        extras.delete(key)
        clearDocs(key)
      }
      await session.server.dispose(false)
      logError('Language server initialization failed', { id: spec.id, error: String(error) })
      return false
    }
  })()
  starting.set(key, promise)
  try {
    return await promise
  } finally {
    if (starting.get(key) === promise) starting.delete(key)
  }
}

async function requestDocument(
  session: ExtraSession,
  filePath: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const doc = openDocs.get(filePath)
  const result = await session.server.request(method, params)
  const latest = openDocs.get(filePath)
  if (
    !session.server.active ||
    latest?.version !== doc?.version ||
    latest?.serverId !== doc?.serverId
  )
    throw new Error('Stale document response')
  return result
}

const extraDiagHandlers = new Set<(items: LspDiagnostic[]) => void>()

function notifyDiagnostics(items: LspDiagnostic[]): void {
  for (const h of extraDiagHandlers) {
    try {
      h(items)
    } catch {
      // ignore
    }
  }
}

export function onExtraLspDiagnostics(handler: (items: LspDiagnostic[]) => void): () => void {
  extraDiagHandlers.add(handler)
  return () => extraDiagHandlers.delete(handler)
}

function clearDocs(key: string) {
  for (const [path, doc] of openDocs) if (doc.serverId === key) openDocs.delete(path)
}
async function disposeExtra(key: string): Promise<void> {
  const session = extras.get(key)
  if (!session) return
  extras.delete(key)
  starting.delete(key)
  clearDocs(key)
  await session.server.dispose()
}

export async function disposeLanguageServers(): Promise<void> {
  workspaceRoot = null
  configureTsLspRoot(null)
  await Promise.all([...extras.keys()].map((id) => disposeExtra(id)))
  await disposeTsLsp()
  openDocs.clear()
}

export async function lspDidOpen(
  root: string,
  filePath: string,
  language: string,
  text: string
): Promise<void> {
  if (isTsLike(language, filePath)) {
    await tsDidOpen(root, filePath, language, text)
    return
  }
  const spec = matchServer(language, filePath)
  if (!spec || !(await ensureExtra(root, spec))) return
  const session = sessionFor(root, spec)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root)) return
  if (openDocs.get(filePath)?.serverId === session.key) {
    await lspDidChange(root, filePath, language, text)
    return
  }
  const version = 1
  openDocs.set(filePath, { version, languageId: spec.languageId, serverId: session.key })
  session.server.notify('textDocument/didOpen', {
    textDocument: { uri: uriFor(filePath), languageId: spec.languageId, version, text }
  })
}

/** Ensure agent queries can address a document without overwriting an open editor buffer. */
export async function lspEnsureOpen(
  root: string,
  filePath: string,
  language: string,
  text: string
): Promise<boolean> {
  if (isTsLike(language, filePath)) return tsEnsureOpen(root, filePath, language, text)
  const existing = openDocs.get(filePath)
  if (
    existing &&
    extras.get(existing.serverId)?.root === realpathAllowMissing(root) &&
    extras.get(existing.serverId)?.server.active
  )
    return true
  const spec = matchServer(language, filePath)
  if (!spec || !(await ensureExtra(root, spec))) return false
  const session = sessionFor(root, spec)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root))
    return false
  if (openDocs.has(filePath)) {
    await lspDidChange(root, filePath, language, text)
    return true
  }
  openDocs.set(filePath, { version: 1, languageId: spec.languageId, serverId: session.key })
  session.server.notify('textDocument/didOpen', {
    textDocument: {
      uri: uriFor(filePath),
      languageId: spec.languageId,
      version: 1,
      text
    }
  })
  return true
}

export async function lspDidChange(
  root: string,
  filePath: string,
  language: string,
  text: string
): Promise<void> {
  if (isTsLike(language, filePath)) {
    await tsDidChange(root, filePath, language, text)
    return
  }
  const prev = openDocs.get(filePath)
  if (!prev) {
    await lspDidOpen(root, filePath, language, text)
    return
  }
  const session = extras.get(prev.serverId)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root)) return
  const version = prev.version + 1
  openDocs.set(filePath, { ...prev, version })
  session.server.notify('textDocument/didChange', {
    textDocument: { uri: uriFor(filePath), version },
    contentChanges: [{ text }]
  })
}

export async function lspDidClose(filePath: string): Promise<void> {
  const prev = openDocs.get(filePath)
  if (prev) {
    extras.get(prev.serverId)?.server.notify('textDocument/didClose', {
      textDocument: { uri: uriFor(filePath) }
    })
    openDocs.delete(filePath)
  }
  await tsDidClose(filePath)
}

export async function lspHover(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{ ok: boolean; contents: string }> {
  if (isTsLike('', filePath)) return tsHover(root, filePath, line, character)
  const spec = matchServer('', filePath)
  if (!spec || !(await ensureExtra(root, spec))) return { ok: false, contents: '' }
  const session = sessionFor(root, spec)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root))
    return { ok: false, contents: '' }
  try {
    const result = (await requestDocument(session, filePath, 'textDocument/hover', {
      textDocument: { uri: uriFor(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
    })) as { contents?: unknown } | null
    return { ok: true, contents: formatMarkup(result?.contents) }
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
  if (isTsLike('', filePath)) return tsDefinition(root, filePath, line, character)
  const spec = matchServer('', filePath)
  if (!spec || !(await ensureExtra(root, spec))) return { ok: false, locations: [] }
  const session = sessionFor(root, spec)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root))
    return { ok: false, locations: [] }
  try {
    const result = (await requestDocument(session, filePath, 'textDocument/definition', {
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
  if (isTsLike('', filePath)) return tsReferences(root, filePath, line, character)
  const spec = matchServer('', filePath)
  if (!spec || !(await ensureExtra(root, spec))) return { ok: false, locations: [] }
  const session = sessionFor(root, spec)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root))
    return { ok: false, locations: [] }
  try {
    const result = (await requestDocument(session, filePath, 'textDocument/references', {
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
  if (isTsLike('', filePath)) return tsCompletion(root, filePath, line, character)
  const spec = matchServer('', filePath)
  if (!spec || !(await ensureExtra(root, spec))) return { ok: false, items: [] }
  const session = sessionFor(root, spec)
  if (!session || !session.server.active || session.root !== realpathAllowMissing(root))
    return { ok: false, items: [] }
  try {
    const result = (await requestDocument(session, filePath, 'textDocument/completion', {
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
  if (!contents) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents
      .map((c) => formatMarkup(c))
      .filter(Boolean)
      .join('\n\n')
  }
  if (contents && typeof contents === 'object') {
    const obj = contents as { value?: string; language?: string }
    if (typeof obj.value === 'string') {
      if (obj.language) return '```' + obj.language + '\n' + obj.value + '\n```'
      return obj.value
    }
  }
  return ''
}

export function listConfiguredLanguageServers(): LanguageServerConfig[] {
  return servers
}

export async function negotiatedLanguageCapabilities(root: string, filePath: string) {
  if (isTsLike('', filePath)) return tsLanguageCapabilities(root, filePath)
  const spec = matchServer('', filePath)
  const ready = spec && (await ensureExtra(root, spec))
  const current = spec ? sessionFor(root, spec) : null
  return languageCapabilities(
    spec?.id ?? 'unconfigured',
    current?.server.capabilities,
    !!ready && !!current?.server.active && openDocs.has(filePath)
  )
}
export async function negotiatedEditRequest(
  root: string,
  filePath: string,
  kind: 'formatting' | 'rename' | 'codeActions',
  params: Record<string, unknown>
) {
  const capabilities = await negotiatedLanguageCapabilities(root, filePath)
  if (!capabilities[kind]) throw new Error(`Language adapter does not advertise ${kind}`)
  const method = kind === 'codeActions' ? 'textDocument/codeAction' : `textDocument/${kind}`
  const payload = { ...params, textDocument: { uri: uriFor(filePath) } }
  if (isTsLike('', filePath)) return tsEditRequest(root, filePath, method, payload)
  const spec = matchServer('', filePath),
    current = spec ? sessionFor(root, spec) : null
  if (!current) throw new Error('Language adapter unavailable')
  const version = openDocs.get(filePath)!.version
  return { response: await requestDocument(current, filePath, method, payload), version }
}
