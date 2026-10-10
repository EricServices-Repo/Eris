import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { workspaceConfigDir } from './paths'
import { buildWorkspaceProcessEnv } from './workspace-env'

export type LaunchConfig = {
  id: string
  name: string
  type: 'node'
  request: 'launch'
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  runtimeArgs?: string[]
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
  config: LaunchConfig
  breakpoints: Breakpoint[]
  state: DebugSessionState
  msgId: number
  pending: Map<number, (msg: Record<string, unknown>) => void>
}

let session: InternalSession | null = null
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
      type: 'node',
      request: 'launch'
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

async function cdpSend(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Debugger not connected')
  }
  const id = ++session.msgId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session?.pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 10_000)
    session!.pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve((msg.result as Record<string, unknown>) || {})
    })
    session!.ws!.send(JSON.stringify({ id, method, params }))
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

async function connectInspector(port: number): Promise<void> {
  // Wait for inspector HTTP endpoint
  let wsUrl: string | null = null
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = (await res.json()) as Array<{ webSocketDebuggerUrl?: string }>
      wsUrl = list[0]?.webSocketDebuggerUrl || null
      if (wsUrl) break
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  if (!wsUrl || !session) throw new Error('Could not attach to Node inspector')

  const ws = new WebSocket(wsUrl)
  session.ws = ws
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('WebSocket attach failed'))
  })
  ws.onmessage = (ev) => {
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

  await cdpSend('Debugger.enable')
  await cdpSend('Runtime.enable')
  await syncBreakpoints()
  await cdpSend('Runtime.runIfWaitingForDebugger')
}

function resolveProgram(
  workspacePath: string,
  program: string,
  activeFile: string | null
): string {
  if (program === '${file}') {
    if (!activeFile) throw new Error('Open a file to debug (${file})')
    return activeFile
  }
  if (program.startsWith('/')) return program
  return join(workspacePath, program)
}

export async function startDebug(options: {
  workspacePath: string
  config: LaunchConfig
  activeFile?: string | null
}): Promise<DebugSessionState> {
  if (session) await stopDebug()
  const port = 9229 + Math.floor(Math.random() * 200)
  const program = resolveProgram(
    options.workspacePath,
    options.config.program,
    options.activeFile ?? null
  )
  if (!existsSync(program)) throw new Error(`Program not found: ${program}`)

  const runtimeArgs = options.config.runtimeArgs || []
  const args = [
    `--inspect-brk=127.0.0.1:${port}`,
    ...runtimeArgs,
    program,
    ...(options.config.args || [])
  ]
  const cwd = options.config.cwd
    ? options.config.cwd.startsWith('/')
      ? options.config.cwd
      : join(options.workspacePath, options.config.cwd)
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

  nodeChild.stdout?.on('data', (d) => appendOut(String(d)))
  nodeChild.stderr?.on('data', (d) => appendOut(String(d)))
  nodeChild.on('close', (code) => {
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
    await connectInspector(port)
    appendOut('[debugger attached]\n')
  } catch (err) {
    appendOut(`[attach failed] ${err instanceof Error ? err.message : String(err)}\n`)
  }
  return getDebugState()
}

export async function stopDebug(): Promise<DebugSessionState> {
  if (!session) return getDebugState()
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
  await cdpSend('Debugger.resume')
}

export async function debugStepOver(): Promise<void> {
  await cdpSend('Debugger.stepOver')
}

export async function debugStepInto(): Promise<void> {
  await cdpSend('Debugger.stepInto')
}

export async function debugStepOut(): Promise<void> {
  await cdpSend('Debugger.stepOut')
}
