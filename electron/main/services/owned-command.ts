import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { appResourcePath } from './paths'

export function spawnOwnedCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    const helper = appResourcePath('native/eris-owned-command.exe')
    return spawn(helper, [], {
      cwd,
      env: { ...env, ERIS_OWNED_COMMAND: command },
      windowsHide: true,
      stdio: 'pipe'
    })
  }
  return spawn(command, { cwd, env, shell: true, detached: true, stdio: 'pipe' })
}
/** POSIX command session/process group; Windows helper's Job closes on exit/kill. */
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
