import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { buildWorkspaceProcessEnv } from './workspace-env'
import { activeDiagnosticsScope } from './model-transport'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT = 80_000
const BLOCKED = /(?:rm\s+-rf\s+\/|mkfs|dd\s+if=|:\(\)\s*\{\s*:\|:&\s*\})/i

export interface RunCommandResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  command: string
}

/** Run a command in the workspace folder (for agent + terminal panel). */
export function runWorkspaceCommand(
  workspacePath: string,
  command: string,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    env?: NodeJS.ProcessEnv
    /** Live stdout/stderr chunks (for terminal panel streaming). */
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void
  }
): Promise<RunCommandResult> {
  const cmd = command.trim()
  if (!cmd) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: 'Empty command',
      timedOut: false,
      command: cmd
    })
  }
  if (!existsSync(workspacePath)) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: 'Workspace folder missing',
      timedOut: false,
      command: cmd
    })
  }
  if (BLOCKED.test(cmd)) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: 'Command blocked for safety',
      timedOut: false,
      command: cmd
    })
  }
  const diagnostics = activeDiagnosticsScope()
  if (diagnostics) {
    diagnostics.onBlockedEffect('command', cmd)
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: 'Host commands are disabled in diagnostics runs',
      timedOut: false,
      command: cmd
    })
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env = buildWorkspaceProcessEnv(workspacePath, options?.env)

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: workspacePath,
      shell: true,
      env
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      const trim = (s: string) =>
        s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s
      let err = trim(stderr)
      const combined = `${stdout}\n${stderr}`
      // npm ran but a script binary (jest, tsc, …) is missing → deps, not PATH.
      const missingScriptBin =
        />\s+\S+/.test(combined) && /sh:\s+\S+:\s+command not found/i.test(combined)
      const missingHostTool =
        (code === 127 || /command not found/i.test(err)) &&
        !missingScriptBin &&
        /(?:^|\/bin\/sh:\s+|\/bin\/bash:\s+)(?:npm|node|pnpm|yarn|npx):\s+command not found/i.test(
          combined
        )
      if (missingScriptBin) {
        err =
          (err ? `${err}\n` : '') +
          'Hint: A project tool is missing from node_modules/.bin. Run `npm install` in this workspace.'
      } else if (missingHostTool) {
        err =
          (err ? `${err}\n` : '') +
          'Hint: Eris could not find npm/node on PATH. Install Node (e.g. Homebrew) ' +
          'or relaunch Eris from a terminal after `which npm` works.'
      }
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: trim(stdout),
        stderr: err,
        timedOut,
        command: cmd
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000)
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 500)
      finish(null)
    }
    if (options?.signal?.aborted) {
      onAbort()
      return
    }
    options?.signal?.addEventListener('abort', onAbort)

    child.stdout.on('data', (d) => {
      const text = String(d)
      stdout += text
      options?.onChunk?.(text, 'stdout')
      if (stdout.length > MAX_OUTPUT * 2) child.kill('SIGTERM')
    })
    child.stderr.on('data', (d) => {
      const text = String(d)
      stderr += text
      options?.onChunk?.(text, 'stderr')
    })
    child.on('close', (code) => finish(code))
    child.on('error', (err) => {
      stderr += err.message
      finish(1)
    })
  })
}
