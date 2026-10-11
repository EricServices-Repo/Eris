import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { AppSettings, McpServerConfig } from '../../../src/shared/settings-schema'
import { listEnabledMcpServers } from './mcp'
import { logError, logInfo, logWarn } from './logger'

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.2.0'
  }
}

export type McpToolInfo = {
  serverId: string
  serverName: string
  name: string
  description: string
  /** Fully-qualified tool name for the agent: mcp__serverId__toolName */
  fqName: string
}

export type McpServerStatus = {
  id: string
  name: string
  transport: McpServerConfig['transport']
  connected: boolean
  toolCount: number
  error?: string
}

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type Session = {
  config: McpServerConfig
  tools: McpToolInfo[]
  error?: string
  connected: boolean
  /** stdio */
  child?: ChildProcessWithoutNullStreams
  buffer?: Buffer
  pending?: Map<
    number,
    { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
  >
  nextId?: number
  /** http/sse */
  sessionUrl?: string
}

const sessions = new Map<string, Session>()

function fqName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${safeServer}__${safeTool}`
}

function parseFqName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const idx = rest.indexOf('__')
  if (idx <= 0) return null
  return { serverId: rest.slice(0, idx), toolName: rest.slice(idx + 2) }
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__') && name.includes('__', 5)
}

function writeStdioMessage(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
  child.stdin.write(Buffer.concat([header, body]))
}

function feedStdio(session: Session, chunk: Buffer): void {
  session.buffer = Buffer.concat([session.buffer || Buffer.alloc(0), chunk])
  for (;;) {
    const buf: Buffer = session.buffer ?? Buffer.alloc(0)
    const headerEnd = buf.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buf.subarray(0, headerEnd).toString('utf8')
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) {
      session.buffer = Buffer.from(buf.subarray(headerEnd + 4))
      continue
    }
    const len = Number(match[1])
    const start = headerEnd + 4
    if (buf.length < start + len) return
    const json = buf.subarray(start, start + len).toString('utf8')
    session.buffer = Buffer.from(buf.subarray(start + len))
    try {
      const msg = JSON.parse(json) as JsonRpcResponse
      if (msg.id != null && session.pending) {
        const pending = session.pending.get(Number(msg.id))
        if (pending) {
          session.pending.delete(Number(msg.id))
          pending.resolve(msg)
        }
      }
    } catch (err) {
      logWarn('MCP stdio JSON parse failed', {
        id: session.config.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

function stdioRequest(session: Session, method: string, params?: unknown): Promise<unknown> {
  if (!session.child || !session.pending || session.nextId == null) {
    return Promise.reject(new Error('MCP stdio session not connected'))
  }
  const id = session.nextId++
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending?.delete(id)
      reject(new Error(`MCP timeout: ${method}`))
    }, 30_000)
    session.pending!.set(id, {
      resolve: (msg) => {
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    writeStdioMessage(session.child!, req)
  })
}

async function connectStdio(config: McpServerConfig, cwd: string | null): Promise<Session> {
  const session: Session = {
    config,
    tools: [],
    connected: false,
    buffer: Buffer.alloc(0),
    pending: new Map(),
    nextId: 1
  }
  const env = { ...process.env, ...config.env }
  const child = spawn(config.command, config.args || [], {
    cwd: cwd || undefined,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  session.child = child
  child.stdout.on('data', (d: Buffer) => feedStdio(session, d))
  child.stderr.on('data', (d: Buffer) => {
    const text = d.toString('utf8').trim()
    if (text) logWarn('MCP stderr', { id: config.id, text: text.slice(0, 400) })
  })
  child.on('error', (err) => {
    session.error = err.message
    session.connected = false
  })
  child.on('close', () => {
    session.connected = false
    for (const [, p] of session.pending || []) {
      p.reject(new Error('MCP process exited'))
    }
    session.pending?.clear()
  })

  await stdioRequest(session, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'Eris', version: appVersion() }
  })
  writeStdioMessage(child, {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  })
  const listed = (await stdioRequest(session, 'tools/list', {})) as {
    tools?: Array<{ name: string; description?: string }>
  }
  session.tools = (listed.tools || []).map((t) => ({
    serverId: config.id,
    serverName: config.name,
    name: t.name,
    description: t.description || '',
    fqName: fqName(config.id, t.name)
  }))
  session.connected = true
  return session
}

async function httpRpc(
  url: string,
  method: string,
  params?: unknown,
  id = 1
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  // Handle bare JSON or simple SSE data: lines
  let jsonText = text.trim()
  if (jsonText.startsWith('data:')) {
    const line = jsonText
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'))
    jsonText = line ? line.slice(5).trim() : jsonText
  }
  const msg = JSON.parse(jsonText) as JsonRpcResponse
  if (msg.error) throw new Error(msg.error.message)
  return msg.result
}

async function connectHttpLike(config: McpServerConfig): Promise<Session> {
  const session: Session = {
    config,
    tools: [],
    connected: false,
    sessionUrl: config.url
  }
  await httpRpc(config.url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'Eris', version: appVersion() }
  })
  try {
    await httpRpc(config.url, 'notifications/initialized', {})
  } catch {
    // notification may not return a body
  }
  const listed = (await httpRpc(config.url, 'tools/list', {}, 2)) as {
    tools?: Array<{ name: string; description?: string }>
  }
  session.tools = (listed.tools || []).map((t) => ({
    serverId: config.id,
    serverName: config.name,
    name: t.name,
    description: t.description || '',
    fqName: fqName(config.id, t.name)
  }))
  session.connected = true
  return session
}

async function disconnectSession(session: Session): Promise<void> {
  if (session.child) {
    try {
      session.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    session.child = undefined
  }
  session.connected = false
}

export async function syncMcpRuntime(
  settings: AppSettings,
  workspacePath: string | null
): Promise<McpServerStatus[]> {
  const enabled = listEnabledMcpServers(settings)
  const keep = new Set(enabled.map((s) => s.id))

  for (const [id, session] of [...sessions.entries()]) {
    if (!keep.has(id)) {
      await disconnectSession(session)
      sessions.delete(id)
    }
  }

  for (const config of enabled) {
    const existing = sessions.get(config.id)
    const same =
      existing &&
      existing.config.transport === config.transport &&
      existing.config.command === config.command &&
      JSON.stringify(existing.config.args) === JSON.stringify(config.args) &&
      existing.config.url === config.url &&
      JSON.stringify(existing.config.env) === JSON.stringify(config.env)
    if (same && existing?.connected) continue
    if (existing) {
      await disconnectSession(existing)
      sessions.delete(config.id)
    }
    try {
      const session =
        config.transport === 'stdio'
          ? await connectStdio(config, workspacePath)
          : await connectHttpLike(config)
      sessions.set(config.id, session)
      logInfo('MCP server connected', {
        id: config.id,
        tools: session.tools.length,
        transport: config.transport
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('MCP connect failed', { id: config.id, error: message })
      sessions.set(config.id, {
        config,
        tools: [],
        connected: false,
        error: message
      })
    }
  }

  return getMcpStatuses()
}

export function getMcpStatuses(): McpServerStatus[] {
  return [...sessions.values()].map((s) => ({
    id: s.config.id,
    name: s.config.name,
    transport: s.config.transport,
    connected: s.connected,
    toolCount: s.tools.length,
    error: s.error
  }))
}

export function listMcpTools(): McpToolInfo[] {
  const out: McpToolInfo[] = []
  for (const session of sessions.values()) {
    if (session.connected) out.push(...session.tools)
  }
  return out
}

export function formatLiveMcpToolsPrompt(): string {
  const tools = listMcpTools()
  if (tools.length === 0) {
    const statuses = getMcpStatuses()
    if (statuses.length === 0) return ''
    const errs = statuses
      .filter((s) => s.error)
      .map((s) => `- ${s.name}: ${s.error}`)
      .join('\n')
    return [
      'MCP servers are configured but none exposed tools yet.',
      errs || 'Check Settings → MCP connection status.'
    ].join('\n')
  }
  const lines = tools.map(
    (t) =>
      `- ${t.fqName} — ${t.description || t.name} (server: ${t.serverName})`
  )
  return [
    'Live MCP tools (call with {"name":"<fqName>", ...args}):',
    ...lines,
    'Prefer native Eris file tools for edits; use MCP for integrations.'
  ].join('\n')
}

export async function callMcpTool(
  fq: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; detail: string }> {
  const parsed = parseFqName(fq)
  if (!parsed) return { ok: false, detail: `Invalid MCP tool name: ${fq}` }

  // Resolve server by id, or by sanitized id match
  let session: Session | undefined
  for (const [id, s] of sessions) {
    if (id === parsed.serverId || id.replace(/[^a-zA-Z0-9_-]/g, '_') === parsed.serverId) {
      session = s
      break
    }
  }
  if (!session || !session.connected) {
    return { ok: false, detail: `MCP server not connected: ${parsed.serverId}` }
  }

  const tool = session.tools.find(
    (t) => t.name === parsed.toolName || t.fqName === fq
  )
  const toolName = tool?.name || parsed.toolName
  // Strip bookkeeping keys from args
  const { name: _n, ...rest } = args
  void _n

  try {
    let result: unknown
    if (session.config.transport === 'stdio') {
      result = await stdioRequest(session, 'tools/call', {
        name: toolName,
        arguments: rest
      })
    } else {
      result = await httpRpc(session.sessionUrl || session.config.url, 'tools/call', {
        name: toolName,
        arguments: rest
      })
    }
    const detail =
      typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2)
    return { ok: true, detail: detail.slice(0, 50_000) }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function disposeMcpRuntime(): Promise<void> {
  for (const session of sessions.values()) {
    await disconnectSession(session)
  }
  sessions.clear()
}
