import { languageServerLaunch } from './lsp-paths'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
/** Stdio DAP only. Adapter command is a user-installed executable, never supplied by model output. */
export class DapSession {
  readonly child: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private seq = 0
  private pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private ended = false
  capabilities: Record<string, unknown> = {}
  constructor(
    root: string,
    command: string,
    args: string[],
    private event: (name: string, body: Record<string, unknown>) => void,
    private exit: (reason: string) => void
  ) {
    const launch = languageServerLaunch(command, args, root)
    this.child = spawn(launch.command, launch.args, {
      cwd: root,
      env: launch.env,
      stdio: 'pipe',
      windowsHide: true
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.read(chunk)
      } catch (e) {
        this.fail(String(e))
      }
    })
    this.child.stderr.on('data', () => {})
    this.child.once('error', (e) => this.fail(e.message))
    this.child.once('exit', () => this.fail('Debug adapter exited'))
  }
  get active() {
    return !this.ended
  }
  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > 4 * 1024 * 1024 + 16384) throw new Error('DAP frame exceeds limit')
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n')
      if (boundary < 0) {
        if (this.buffer.length > 16384) throw new Error('DAP header exceeds limit')
        return
      }
      if (boundary > 16384) throw new Error('DAP header exceeds limit')
      const header = this.buffer.subarray(0, boundary).toString('ascii'),
        matches = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
      if (matches.length !== 1) throw new Error('Invalid DAP frame header')
      const length = Number(matches[0][1])
      if (length <= 0 || length > 4 * 1024 * 1024) throw new Error('DAP body exceeds limit')
      if (this.buffer.length < boundary + 4 + length) return
      const msg = JSON.parse(
        this.buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8')
      ) as Record<string, unknown>
      this.buffer = this.buffer.subarray(boundary + 4 + length)
      if (msg.type === 'response') {
        const pending = this.pending.get(Number(msg.request_seq))
        if (!pending) continue
        this.pending.delete(Number(msg.request_seq))
        clearTimeout(pending.timer)
        if (msg.success !== true)
          pending.reject(new Error(String(msg.message ?? 'DAP request failed').slice(0, 1000)))
        else pending.resolve((msg.body ?? {}) as Record<string, unknown>)
      } else if (msg.type === 'event')
        this.event(String(msg.event), (msg.body ?? {}) as Record<string, unknown>)
      else if (msg.type === 'request') {
        // Never execute reverse requests such as runInTerminal or startDebugging.
        this.send({
          seq: ++this.seq,
          type: 'response',
          request_seq: msg.seq,
          command: msg.command,
          success: false,
          message: 'Reverse process/network requests are unsupported'
        })
      }
    }
  }
  private send(value: unknown) {
    const body = Buffer.from(JSON.stringify(value))
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }
  request(
    command: string,
    args: unknown = {},
    timeoutMs = 10000
  ): Promise<Record<string, unknown>> {
    if (this.ended) return Promise.reject(new Error('Debug adapter stopped'))
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many debugger requests'))
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(`DAP ${command} timed out`), timeoutMs)
      this.pending.set(seq, { resolve, reject, timer })
      try {
        this.send({ seq, type: 'request', command, arguments: args })
      } catch (e) {
        this.fail(String(e))
      }
    })
  }
  private fail(reason: string) {
    if (this.ended) return
    this.ended = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.buffer = Buffer.alloc(0)
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    }, 500)
    timer.unref()
    this.exit(reason)
  }
  async stop(terminateDebuggee: boolean) {
    if (!this.ended) await this.request('disconnect', { terminateDebuggee }, 1000).catch(() => {})
    this.fail('Debugger stopped')
    if (this.child.exitCode === null && this.child.signalCode === null)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          this.child.removeListener('exit', done)
          resolve()
        }, 1200)
        this.child.once('exit', done)
      })
  }
}
