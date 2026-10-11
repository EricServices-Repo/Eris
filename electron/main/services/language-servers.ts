import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { AppSettings, LanguageServerConfig } from '../../../src/shared/settings-schema'
import { logError, logInfo, logWarn } from './logger'
import {
  disposeTsLsp,
  isTsLike,
  lspCompletion as tsCompletion,
  lspDefinition as tsDefinition,
  lspDidChange as tsDidChange,
  lspDidClose as tsDidClose,
  lspDidOpen as tsDidOpen,
  lspHover as tsHover,
  onLspDiagnostics,
  type LspDiagnostic
} from './ts-lsp'

type ExtraSession = {
  id: string
  proc: ChildProcessWithoutNullStreams
  connection: MessageConnection
  languageId: string
}

const extras = new Map<string, ExtraSession>()
const starting = new Map<string, Promise<boolean>>()
const openDocs = new Map<string, { version: number; languageId: string; serverId: string }>()
let servers: LanguageServerConfig[] = []
let workspaceRoot: string | null = null

export { onLspDiagnostics, type LspDiagnostic }

export function configureLanguageServers(settings: AppSettings, root: string | null): void {
  servers = settings.intelligence.languageServers.filter((s) => s.enabled && s.command)
  workspaceRoot = root
}

function uriFor(filePath: string): string {
  return pathToFileURL(filePath).href
}

function pathFromUri(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname)
  } catch {
    return uri.replace(/^file:\/\//, '')
  }
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
    servers.find((s) => s.extensions.map((e) => e.replace(/^\./, '').toLowerCase()).includes(ext)) ||
    null
  )
}

function resolveBin(command: string): string {
  if (command.includes('/') && existsSync(command)) return command
  const path = process.env.PATH || ''
  for (const dir of path.split(':')) {
    const cand = join(dir, command)
    if (existsSync(cand)) return cand
  }
  return command
}

async function ensureExtra(root: string, spec: LanguageServerConfig): Promise<boolean> {
  const existing = extras.get(spec.id)
  if (existing && workspaceRoot === root) return true
  const inflight = starting.get(spec.id)
  if (inflight) return inflight
  const p = (async () => {
    await disposeExtra(spec.id)
    const command = resolveBin(spec.command)
    try {
      const proc = spawn(command, spec.args, {
        cwd: root,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      proc.stderr?.on('data', (buf: Buffer) => {
        const text = buf.toString('utf8').trim()
        if (text) logWarn(`${spec.id} lsp stderr`, { text: text.slice(0, 400) })
      })
      proc.on('exit', () => {
        extras.delete(spec.id)
      })
      const conn = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin)
      )
      conn.onNotification(
        'textDocument/publishDiagnostics',
        (params: {
          uri: string
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
          const items: LspDiagnostic[] = (params.diagnostics || []).map((d) => ({
            path: pathFromUri(params.uri),
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
      conn.listen()
      await conn.sendRequest('initialize', {
        processId: process.pid,
        rootUri: uriFor(root),
        rootPath: root,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            completion: { completionItem: { snippetSupport: false } },
            publishDiagnostics: {}
          },
          workspace: { workspaceFolders: true }
        },
        workspaceFolders: [{ uri: uriFor(root), name: 'workspace' }]
      })
      conn.sendNotification('initialized', {})
      extras.set(spec.id, { id: spec.id, proc, connection: conn, languageId: spec.languageId })
      logInfo('Language server ready', { id: spec.id, command })
      return true
    } catch (err) {
      logError('Language server failed', {
        id: spec.id,
        error: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  })()
  starting.set(spec.id, p)
  try {
    return await p
  } finally {
    starting.delete(spec.id)
  }
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

async function disposeExtra(id: string): Promise<void> {
  const session = extras.get(id)
  extras.delete(id)
  if (!session) return
  try {
    await session.connection.sendRequest('shutdown', null)
  } catch {
    // ignore
  }
  try {
    session.connection.sendNotification('exit')
    session.connection.dispose()
  } catch {
    // ignore
  }
  if (!session.proc.killed) {
    try {
      session.proc.kill()
    } catch {
      // ignore
    }
  }
}

export async function disposeLanguageServers(): Promise<void> {
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
  workspaceRoot = root
  if (isTsLike(language, filePath)) {
    await tsDidOpen(root, filePath, language, text)
    return
  }
  const spec = matchServer(language, filePath)
  if (!spec || !(await ensureExtra(root, spec))) return
  const session = extras.get(spec.id)
  if (!session) return
  const version = 1
  openDocs.set(filePath, { version, languageId: spec.languageId, serverId: spec.id })
  session.connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: uriFor(filePath), languageId: spec.languageId, version, text }
  })
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
  if (!session) return
  const version = prev.version + 1
  openDocs.set(filePath, { ...prev, version })
  session.connection.sendNotification('textDocument/didChange', {
    textDocument: { uri: uriFor(filePath), version },
    contentChanges: [{ text }]
  })
}

export async function lspDidClose(filePath: string): Promise<void> {
  const prev = openDocs.get(filePath)
  if (prev) {
    extras.get(prev.serverId)?.connection.sendNotification('textDocument/didClose', {
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
  const session = extras.get(spec.id)
  if (!session) return { ok: false, contents: '' }
  try {
    const result = (await session.connection.sendRequest('textDocument/hover', {
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
  const session = extras.get(spec.id)
  if (!session) return { ok: false, locations: [] }
  try {
    const result = (await session.connection.sendRequest('textDocument/definition', {
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

export async function lspCompletion(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{ ok: boolean; items: Array<{ label: string; detail?: string; insertText?: string }> }> {
  if (isTsLike('', filePath)) return tsCompletion(root, filePath, line, character)
  const spec = matchServer('', filePath)
  if (!spec || !(await ensureExtra(root, spec))) return { ok: false, items: [] }
  const session = extras.get(spec.id)
  if (!session) return { ok: false, items: [] }
  try {
    const result = (await session.connection.sendRequest('textDocument/completion', {
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
    return contents.map((c) => formatMarkup(c)).filter(Boolean).join('\n\n')
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
