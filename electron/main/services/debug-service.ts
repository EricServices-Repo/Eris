import { DapDebugger } from './dap-debugger'
import { getUserSettings } from './settings'
import { isWorkspaceTrusted } from './workspace-trust'
import { resolveInWorkspace } from './workspace-fs'
import { NODE_DEBUG_CAPABILITIES } from '../../../src/shared/ide-capabilities'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { workspaceConfigDir } from './paths'
import { buildWorkspaceProcessEnv } from './workspace-env'

export type LaunchConfig = {
  id: string
  name: string
  type: string
  request: string
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  runtimeArgs?: string[]
  port?: number
  host?: string
}

export type Breakpoint = {
  id: string
  path: string
  line: number
  enabled: boolean
}

export type DebugSessionState = {
  running: boolean
  paused: boolean
  configId: string | null
  program: string | null
  port: number | null
  output: string
  reason?: string
  callFrames?: Array<{ functionName: string; url: string; lineNumber: number }>
}

type InternalSession = {
  child: ChildProcess
  ws: WebSocket | null
  port: number
  inspectorUrl?: string
  config: LaunchConfig
  breakpoints: Breakpoint[]
  state: DebugSessionState
  msgId: number
  pending: Map<number, (msg: Record<string, unknown>) => void>
}

let session: InternalSession | null = null
let dap: DapDebugger | null = null
const listeners = new Set<(s: DebugSessionState) => void>()

function launchPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'launch.json')
}

function bpPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'breakpoints.json')
}

function emit(): void {
  if (!session) return
  for (const cb of listeners) cb({ ...session.state })
}

export function onDebugState(cb: (s: DebugSessionState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getDebugState(): DebugSessionState {
  return (
    dap?.state ??
    session?.state ?? {
      running: false,
      paused: false,
      configId: null,
      program: null,
      port: null,
      output: ''
    }
  )
}

export function listLaunchConfigs(workspacePath: string): LaunchConfig[] {
  const path = launchPath(workspacePath)
  if (!existsSync(path)) {
    const defaults: LaunchConfig[] = [
      {
        id: 'node-index',
        name: 'Node: current file / index',
        type: 'node',
        request: 'launch',
        program: '${file}',
        runtimeArgs: ['--enable-source-maps']
      }
    ]
    return defaults
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { configurations?: LaunchConfig[] }
    return (raw.configurations || []).map((c, i) => ({
      ...c,
      id: c.id || `cfg-${i}`,
      type: typeof c.type === 'string' ? c.type : 'unsupported',
      request: typeof c.request === 'string' ? c.request : 'unsupported'
    }))
  } catch {
    return []
  }
}

export function saveLaunchConfigs(workspacePath: string, configs: LaunchConfig[]): void {
  mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
  writeFileSync(
    launchPath(workspacePath),
    JSON.stringify({ version: '0.1.0', configurations: configs }, null, 2),
    'utf8'
  )
}

export function listBreakpoints(workspacePath: string): Breakpoint[] {
  const path = bpPath(workspacePath)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Breakpoint[]
  } catch {
    return []
  }
}

export function saveBreakpoints(workspacePath: string, bps: Breakpoint[]): void {
  mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
  writeFileSync(bpPath(workspacePath), JSON.stringify(bps, null, 2), 'utf8')
  if (session) {
    session.breakpoints = bps.filter((b) => b.enabled)
    void syncBreakpoints()
  }
}

function appendOut(text: string): void {
  if (!session) return
  session.state.output = (session.state.output + text).slice(-80_000)
  emit()
}

async function cdpSend(
  method: string,
  params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Debugger not connected')
  }
  const owned = session
  const id = ++owned.msgId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      owned.pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 10_000)
    owned.pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve((msg.result as Record<string, unknown>) || {})
    })
    owned.ws!.send(JSON.stringify({ id, method, params }))
  })
}

async function syncBreakpoints(): Promise<void> {
  if (!session?.ws) return
  try {
    await cdpSend('Debugger.setBreakpointsActive', { active: true })
    for (const bp of session.breakpoints) {
      const url = bp.path.startsWith('file://') ? bp.path : `file://${bp.path}`
      await cdpSend('Debugger.setBreakpointByUrl', {
        lineNumber: Math.max(0, bp.line - 1),
        urlRegex: bp.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
      }).catch(async () => {
        await cdpSend('Debugger.setBreakpointByUrl', {
          lineNumber: Math.max(0, bp.line - 1),
          url
        })
      })
    }
  } catch (err) {
    appendOut(`\n[breakpoints] ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

async function connectInspector(owned: InternalSession): Promise<void> {
  // Use only the endpoint advertised by this child. Never probe a guessed port belonging to another process.
  let wsUrl: string | null = null
  for (let i = 0; i < 100; i++) {
    if (session !== owned || owned.child.exitCode !== null)
      throw new Error('Debug session exited or was replaced')
    if (owned.inspectorUrl) {
      wsUrl = owned.inspectorUrl
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!wsUrl || session !== owned) throw new Error('Could not attach to Node inspector')

  const ws = new WebSocket(wsUrl)
  session.ws = ws
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('Inspector handshake timed out'))
    }, 5000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('WebSocket attach failed'))
    }
  })
  ws.onmessage = (ev) => {
    if (session !== owned) return
    try {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>
      if (typeof msg.id === 'number' && session?.pending.has(msg.id)) {
        const cb = session.pending.get(msg.id)!
        session.pending.delete(msg.id)
        cb(msg)
        return
      }
      if (msg.method === 'Debugger.paused') {
        const params = msg.params as {
          reason?: string
          callFrames?: Array<{
            functionName?: string
            url?: string
            location?: { lineNumber?: number }
          }>
        }
        if (session) {
          session.state.paused = true
          session.state.reason = params.reason
          session.state.callFrames = (params.callFrames || []).slice(0, 12).map((f) => ({
            functionName: f.functionName || '(anonymous)',
            url: f.url || '',
            lineNumber: (f.location?.lineNumber ?? 0) + 1
          }))
          emit()
        }
      }
      if (msg.method === 'Debugger.resumed' && session) {
        session.state.paused = false
        session.state.callFrames = []
        emit()
      }
    } catch {
      // ignore
    }
  }

  if (session !== owned) throw new Error('Debug session replaced')
  await cdpSend('Debugger.enable')
  await cdpSend('Runtime.enable')
  await syncBreakpoints()
  await cdpSend('Runtime.runIfWaitingForDebugger')
}

function resolveProgram(workspacePath: string, program: string, activeFile: string | null): string {
  if (program === '${file}') {
    if (!activeFile) throw new Error('Open a file to debug (${file})')
    return resolveInWorkspace(workspacePath, activeFile)
  }
  return resolveInWorkspace(workspacePath, program)
}

export async function startDebug(options: {
  workspacePath: string
  config: LaunchConfig
  activeFile?: string | null
}): Promise<DebugSessionState> {
  const config = options.config
  if (config.type !== 'node' || config.request !== 'launch') {
    const adapter = (getUserSettings().intelligence?.debugAdapters ?? []).find(
      (a) => a.enabled && config.type === `dap:${a.id}`
    )
    if (!adapter || !['launch', 'attach'].includes(config.request))
      throw new Error(
        `Unsupported debug target ${config.type}/${config.request}. Configure an explicit user-owned DAP adapter.`
      )
    if (!isWorkspaceTrusted(options.workspacePath))
      throw new Error('Trust the workspace before launching a debug adapter')
    if (
      config.request === 'attach' &&
      ((config.host && config.host !== '127.0.0.1' && config.host !== 'localhost') ||
        !Number.isInteger(config.port) ||
        config.port! < 1 ||
        config.port! > 65535)
    )
      throw new Error('DAP attach supports an explicit loopback port only')
    const program =
      config.request === 'launch'
        ? resolveInWorkspace(
            options.workspacePath,
            config.program === '${file}' ? (options.activeFile ?? '') : config.program
          )
        : ''
    if (config.request === 'launch' && !existsSync(program))
      throw new Error('Debug program does not exist')
    if (config.cwd) config.cwd = resolveInWorkspace(options.workspacePath, config.cwd)
    await stopDebug()
    const current = new DapDebugger(
      options.workspacePath,
      adapter.command,
      adapter.args ?? [],
      config,
      (state) => {
        if (dap === current) for (const cb of listeners) cb({ ...state })
      }
    )
    dap = current
    try {
      return await current.start(
        options.workspacePath,
        program,
        listBreakpoints(options.workspacePath)
          .filter((b) => b.enabled)
          .map((b) => ({ ...b, path: resolveInWorkspace(options.workspacePath, b.path) }))
      )
    } catch (e) {
      if (dap === current) dap = null
      throw e
    }
  }
  if (session || dap) await stopDebug()
  const port = 0
  const program = resolveProgram(
    options.workspacePath,
    options.config.program,
    options.activeFile ?? null
  )
  if (!existsSync(program)) throw new Error(`Program not found: ${program}`)

  if (!isWorkspaceTrusted(options.workspacePath))
    throw new Error('Trust the workspace before launching a debugger')
  const runtimeArgs = options.config.runtimeArgs || []
  if (runtimeArgs.some((arg) => /^--(?:inspect|debug)/i.test(arg)))
    throw new Error('Inspector endpoint flags are owned by the Node adapter')
  const args = [
    `--inspect-brk=127.0.0.1:${port}`,
    ...runtimeArgs,
    program,
    ...(options.config.args || [])
  ]
  const cwd = options.config.cwd
    ? resolveInWorkspace(options.workspacePath, options.config.cwd)
    : options.workspacePath
  const nodeChild = spawn('node', args, {
    cwd,
    env: buildWorkspaceProcessEnv(options.workspacePath, options.config.env),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  session = {
    child: nodeChild,
    ws: null,
    port,
    config: options.config,
    breakpoints: listBreakpoints(options.workspacePath).filter((b) => b.enabled),
    state: {
      running: true,
      paused: true,
      configId: options.config.id,
      program,
      port,
      output: `$ node ${args.join(' ')}\n`
    },
    msgId: 0,
    pending: new Map()
  }

  const owned = session
  nodeChild.stdout?.on('data', (d) => {
    if (session === owned) appendOut(String(d))
  })
  let stderrPrefix = ''
  nodeChild.stderr?.on('data', (d) => {
    if (session !== owned) return
    stderrPrefix = (stderrPrefix + String(d)).slice(-16000)
    const endpoint = stderrPrefix.match(/ws:\/\/127\.0\.0\.1:(\d+)\/[a-f0-9-]+/i)
    if (endpoint) {
      owned.inspectorUrl = endpoint[0]
      owned.port = Number(endpoint[1])
      owned.state.port = owned.port
    }
    appendOut(String(d))
  })
  nodeChild.once('error', (error) => {
    if (session === owned) {
      owned.state.reason = error.message
      void stopDebug()
    }
  })
  nodeChild.on('close', (code) => {
    if (session !== owned) return
    if (session) {
      session.state.running = false
      session.state.paused = false
      appendOut(`\n[exit ${code ?? '?'}]\n`)
      try {
        session.ws?.close()
      } catch {
        // ignore
      }
      session = null
    }
    emit()
  })

  emit()
  try {
    await connectInspector(owned)
    appendOut('[debugger attached]\n')
  } catch (err) {
    if (session === owned) await stopDebug()
    throw err
  }
  return getDebugState()
}

export async function stopDebug(): Promise<DebugSessionState> {
  if (dap) {
    const previous = dap
    dap = null
    await previous.stop()
    const state = getDebugState()
    for (const cb of listeners) cb(state)
    return state
  }
  if (!session) return getDebugState()
  for (const callback of session.pending.values()) callback({ error: 'Debug session stopped' })
  session.pending.clear()
  try {
    session.ws?.close()
  } catch {
    // ignore
  }
  try {
    session.child.kill('SIGTERM')
  } catch {
    // ignore
  }
  session = null
  const state = getDebugState()
  for (const cb of listeners) cb(state)
  return state
}

export async function debugContinue(): Promise<void> {
  if (dap) return dap.command('continue')
  await cdpSend('Debugger.resume')
}

export async function debugStepOver(): Promise<void> {
  if (dap) return dap.command('next')
  await cdpSend('Debugger.stepOver')
}

export async function debugStepInto(): Promise<void> {
  if (dap) return dap.command('stepIn')
  await cdpSend('Debugger.stepInto')
}

export async function debugStepOut(): Promise<void> {
  if (dap) return dap.command('stepOut')
  await cdpSend('Debugger.stepOut')
}

export function debugAdapterCapabilities() {
  const configured = (getUserSettings().intelligence?.debugAdapters ?? [])
    .filter((a) => a.enabled)
    .map((a) => ({
      version: 1,
      adapter: `dap:${a.id}`,
      transport: 'stdio-dap',
      launch: true,
      attach: true,
      remote: false,
      variables: true,
      watches: true,
      exceptionFilters: [] as string[]
    }))
  return {
    node: NODE_DEBUG_CAPABILITIES,
    configured,
    active: dap
      ? {
          adapter: dap.adapter,
          capabilities: {
            supportsConfigurationDoneRequest:
              dap.client.capabilities.supportsConfigurationDoneRequest === true,
            exceptionBreakpointFilters: (Array.isArray(
              dap.client.capabilities.exceptionBreakpointFilters
            )
              ? dap.client.capabilities.exceptionBreakpointFilters
              : []
            )
              .filter(
                (f): f is { filter: string; label?: string } =>
                  !!f && typeof f === 'object' && typeof f.filter === 'string'
              )
              .slice(0, 32)
              .map((f) => ({
                filter: f.filter.slice(0, 128),
                label: String(f.label ?? f.filter).slice(0, 128)
              }))
          }
        }
      : null
  }
}
export async function debugVariables() {
  if (!dap) throw new Error('Variables require a configured DAP session')
  return dap.variables()
}
export async function debugEvaluate(expression: string) {
  if (!dap) throw new Error('Watches require a configured DAP session')
  const result = await dap.evaluate(expression)
  return String(result.result ?? '').slice(0, 20000)
}
export async function debugExceptions(filters: string[]) {
  if (!dap) throw new Error('Exception controls require a configured DAP session')
  await dap.exceptions(filters)
}
