/** Maintained CLI bridge to the same packaged Eris-Dev adapter used by the UI. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = fileURLToPath(new URL('../..', import.meta.url))
export const kind = 'live'
export const callsPerInvocation = 6
export async function run(input) {
  let executable = process.env.ERIS_DEV_EXECUTABLE
  let args = ['--eris-quality-stdio']
  if (!executable) {
    const candidates =
      process.platform === 'darwin'
        ? [
            'dist-dev/mac-arm64/Eris-Dev.app/Contents/MacOS/Eris-Dev',
            'dist/eris-dev/mac-arm64/Eris-Dev.app/Contents/MacOS/Eris-Dev'
          ]
        : ['dist-dev/win-unpacked/Eris-Dev.exe', 'dist/eris-dev/win-unpacked/Eris-Dev.exe']
    executable = candidates.map((p) => resolve(root, p)).find((p) => existsSync(p))
    if (!executable && existsSync(resolve(root, 'out-dev/main/index.js'))) {
      executable = createRequire(import.meta.url)('electron')
      args = [resolve(root, 'out-dev/main/index.js'), ...args]
    }
  }
  if (!executable || !existsSync(executable))
    throw new Error('Build Eris-Dev or set ERIS_DEV_EXECUTABLE to its installed executable')
  if (input.signal.aborted) throw new Error('Quality request cancelled before launch')
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let output = '',
      settled = false,
      result
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* process already exited */
      }
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      kill()
      if (error) reject(error)
      else resolveResult(result)
    }
    const abort = () => finish(new Error('Quality request cancelled'))
    const timer = setTimeout(() => finish(new Error('Eris-Dev adapter deadline exceeded')), 180000)
    input.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data) => {
      output += String(data)
      if (output.length > 8_000_000) {
        finish(new Error('Quality adapter output exceeds 8 MB'))
        return
      }
      const line = output.split('\n').find((l) => l.startsWith('ERIS_QUALITY_RESULT '))
      if (line) {
        try {
          result = JSON.parse(line.slice(20))
        } catch {
          finish(new Error('Invalid quality adapter result'))
        }
      }
    })
    child.stderr.on('data', () => undefined)
    child.once('error', () => finish(new Error('Could not start Eris-Dev quality adapter')))
    child.once('exit', (code) => {
      if (!settled) {
        if (code === 0 && result) finish(undefined, result)
        else finish(new Error(`Eris-Dev adapter exited before a result (${code})`))
      }
    })
    child.stdin.end(
      JSON.stringify({
        live: true,
        context: 8192,
        test: input.test,
        model: input.model,
        repeat: input.repeat,
        maxCalls: input.maxCalls,
        maxOutputTokens: input.maxOutputTokens
      }) + '\n'
    )
  })
}
