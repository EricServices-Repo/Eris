import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'path'
import { WINDOWS_PROCESS_JOB } from './windows-process-job'

export function spawnOwnedCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.SYSTEMROOT
    if (!root) throw new Error('Windows system directory is unavailable; host execution refused')
    return spawn(
      join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_PROCESS_JOB, 'utf16le').toString('base64')
      ],
      {
        cwd,
        env: {
          ...env,
          ERIS_OWNED_COMMAND: command,
          ERIS_OWNED_TRACE: process.env.ERIS_COMMAND_TRACE === '1' ? '1' : '0'
        },
        windowsHide: true,
        stdio: 'pipe'
      }
    )
  }
  return spawn(command, { cwd, env, shell: true, detached: true, stdio: 'pipe' })
}
/** POSIX command session/process group; Windows wrapper's Job closes on exit/kill. */
export function signalOwnedCommand(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
