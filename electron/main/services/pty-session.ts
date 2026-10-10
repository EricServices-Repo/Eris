import { existsSync } from 'fs'
import { homedir } from 'os'
import type { IPty } from 'node-pty'
import { buildWorkspaceProcessEnv } from './workspace-env'
import { logError, logInfo, logWarn } from './logger'

type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

let pty: IPty | null = null
let workspacePath: string | null = null
const dataHandlers = new Set<DataHandler>()
const exitHandlers = new Set<ExitHandler>()

function defaultShell(): string {
  const envShell = process.env.SHELL
  if (envShell && existsSync(envShell)) return envShell
  if (process.platform === 'darwin' && existsSync('/bin/zsh')) return '/bin/zsh'
  if (existsSync('/bin/bash')) return '/bin/bash'
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
}

export function onPtyData(handler: DataHandler): () => void {
  dataHandlers.add(handler)
  return () => dataHandlers.delete(handler)
}

export function onPtyExit(handler: ExitHandler): () => void {
  exitHandlers.add(handler)
  return () => exitHandlers.delete(handler)
}

export function disposePtySession(): void {
  if (!pty) return
  try {
    pty.kill()
  } catch {
    // ignore
  }
  pty = null
  workspacePath = null
}

export function ensurePtySession(cwd: string, cols = 80, rows = 24): { ok: boolean; error?: string } {
  if (pty && workspacePath === cwd) {
    try {
      pty.resize(Math.max(2, cols), Math.max(1, rows))
    } catch {
      // ignore
    }
    return { ok: true }
  }

  disposePtySession()

  let spawn: typeof import('node-pty').spawn
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    spawn = require('node-pty').spawn as typeof import('node-pty').spawn
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('node-pty load failed', { error: message })
    return { ok: false, error: `Interactive terminal unavailable: ${message}` }
  }

  const shell = defaultShell()
  const env = {
    ...buildWorkspaceProcessEnv(cwd),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOME: process.env.HOME || homedir()
  }

  try {
    pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd,
      env
    })
    workspacePath = cwd
    logInfo('PTY session started', { shell, cwd })

    pty.onData((data) => {
      for (const h of dataHandlers) {
        try {
          h(data)
        } catch {
          // ignore
        }
      }
    })

    pty.onExit(({ exitCode, signal }) => {
      logWarn('PTY exited', { exitCode, signal })
      pty = null
      workspacePath = null
      for (const h of exitHandlers) {
        try {
          h({ exitCode, signal })
        } catch {
          // ignore
        }
      }
    })

    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('PTY spawn failed', { error: message })
    pty = null
    workspacePath = null
    return { ok: false, error: message }
  }
}

export function writePty(data: string): { ok: boolean; error?: string } {
  if (!pty) return { ok: false, error: 'No terminal session' }
  try {
    pty.write(data)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function resizePty(cols: number, rows: number): { ok: boolean; error?: string } {
  if (!pty) return { ok: false, error: 'No terminal session' }
  try {
    pty.resize(Math.max(2, cols), Math.max(1, rows))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
