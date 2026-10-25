import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { pathToFileURL } from 'url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { logError, logInfo, logWarn } from './logger'
import { languageServerFilePath, typescriptLanguageServerLaunch } from './lsp-paths'

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

let proc: ChildProcessWithoutNullStreams | null = null
let connection: MessageConnection | null = null
let workspaceRoot: string | null = null
let starting: Promise<boolean> | null = null
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

async function ensureServer(root: string): Promise<boolean> {
  if (connection && workspaceRoot === root) return true
  if (starting) return starting

  starting = (async () => {
    await disposeTsLsp()
    try {
      const cmd = typescriptLanguageServerLaunch(root)
      proc = spawn(cmd.command, cmd.args, {
        cwd: root,
        env: cmd.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      logError('Failed to spawn typescript-language-server', {
        error: err instanceof Error ? err.message : String(err)
      })
      proc = null
      return false
    }

    proc.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8').trim()
      if (text) logWarn('ts-lsp stderr', { text: text.slice(0, 400) })
    })

    proc.on('exit', () => {
      connection = null
      proc = null
      workspaceRoot = null
      openDocs.clear()
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
        const filePath = pathFromUri(params.uri)
        const items: LspDiagnostic[] = (params.diagnostics || []).map((d) => ({
          path: filePath,
          line: (d.range?.start?.line ?? 0) + 1,
          column: (d.range?.start?.character ?? 0) + 1,
          endLine: (d.range?.end?.line ?? 0) + 1,
          endColumn: (d.range?.end?.character ?? 0) + 1,
          severity: severityFromLsp(d.severity),
          message: d.message,
          source: d.source || 'tsserver'
        }))
        for (const h of diagnosticsHandlers) {
          try {
            h(items)
          } catch {
            // ignore
          }
        }
      }
    )

    conn.listen()

    try {
      await conn.sendRequest('initialize', {
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
        initializationOptions: {
          preferences: {
            includeCompletionsForModuleExports: true
          }
        }
      })
      conn.sendNotification('initialized', {})
      connection = conn
      workspaceRoot = root
      logInfo('TypeScript language server ready', { root })
      return true
    } catch (err) {
      logError('ts-lsp initialize failed', {
        error: err instanceof Error ? err.message : String(err)
      })
      await disposeTsLsp()
      return false
    }
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

export function onLspDiagnostics(handler: DiagnosticsHandler): () => void {
  diagnosticsHandlers.add(handler)
  return () => diagnosticsHandlers.delete(handler)
}

export async function disposeTsLsp(): Promise<void> {
  const conn = connection
  connection = null
  workspaceRoot = null
  openDocs.clear()
  if (conn) {
    try {
      await conn.sendRequest('shutdown', null)
    } catch {
      // ignore
    }
    try {
      conn.sendNotification('exit')
    } catch {
      // ignore
    }
    try {
      conn.dispose()
    } catch {
      // ignore
    }
  }
  if (proc && !proc.killed) {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }
  proc = null
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
  return lang || 'typescript'
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
  if (!connection) return
  if (openDocs.has(filePath)) {
    await lspDidChange(root, filePath, language, text)
    return
  }
  const languageId = languageIdFor(language, filePath)
  const version = 1
  openDocs.set(filePath, { version, languageId })
  connection.sendNotification('textDocument/didOpen', {
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
  if (!(await ensureServer(root)) || !connection) return false
  if (openDocs.has(filePath)) return true
  const languageId = languageIdFor(language, filePath)
  openDocs.set(filePath, { version: 1, languageId })
  connection.sendNotification('textDocument/didOpen', {
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
  if (!connection) return
  const prev = openDocs.get(filePath)
  if (!prev) {
    await lspDidOpen(root, filePath, language, text)
    return
  }
  const version = prev.version + 1
  openDocs.set(filePath, { ...prev, version })
  connection.sendNotification('textDocument/didChange', {
    textDocument: { uri: uriFor(filePath), version },
    contentChanges: [{ text }]
  })
}

export async function lspDidClose(filePath: string): Promise<void> {
  if (!connection || !openDocs.has(filePath)) return
  openDocs.delete(filePath)
  connection.sendNotification('textDocument/didClose', {
    textDocument: { uri: uriFor(filePath) }
  })
}

export async function lspHover(
  root: string,
  filePath: string,
  line: number,
  character: number
): Promise<{ ok: boolean; contents: string }> {
  if (!(await ensureServer(root)) || !connection) {
    return { ok: false, contents: '' }
  }
  try {
    const result = (await connection.sendRequest('textDocument/hover', {
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
  if (!(await ensureServer(root)) || !connection) {
    return { ok: false, locations: [] }
  }
  try {
    const result = (await connection.sendRequest('textDocument/definition', {
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
  if (!(await ensureServer(root)) || !connection) return { ok: false, locations: [] }
  try {
    const result = (await connection.sendRequest('textDocument/references', {
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
  if (!(await ensureServer(root)) || !connection) {
    return { ok: false, items: [] }
  }
  try {
    const result = (await connection.sendRequest('textDocument/completion', {
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
