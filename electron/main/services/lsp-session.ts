import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node'

/** One process and JSON-RPC connection. Disposal cancels only this session's callers. */
export class LspSession {
  readonly proc: ChildProcessWithoutNullStreams
  readonly connection: MessageConnection
  private alive = true
  private connectionDisposed = false
  private pending = new Set<(error: Error) => void>()
  private closing?: Promise<void>
  constructor(
    readonly root: string,
    readonly key: string,
    launch: { command: string; args: string[]; env: NodeJS.ProcessEnv },
    private current: () => boolean,
    exited: () => void
  ) {
    this.proc = spawn(launch.command, launch.args, {
      cwd: root,
      env: launch.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.connection = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin)
    )
    const stop = () => {
      this.abort()
      exited()
    }
    this.proc.once('error', stop)
    this.proc.once('exit', stop)
    this.connection.onClose(() => {
      stop()
      void this.dispose(false)
    })
    this.connection.onError(() => {
      stop()
      void this.dispose(false)
    })
    // Always drain stderr so a chatty server cannot block its stdio transport.
    this.proc.stderr.on('data', () => undefined)
  }
  get active(): boolean {
    return this.alive && this.current()
  }
  listen(): void {
    this.connection.listen()
  }
  notify(method: string, params?: unknown): void {
    if (!this.active) return
    void this.connection.sendNotification(method, params).catch(() => {
      void this.dispose(false)
    })
  }
  async request(
    method: string,
    params: unknown,
    deadlineMs = 10000,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.active || signal?.aborted)
      throw new Error('Language server session is no longer active')
    const source = new CancellationTokenSource()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', aborted)
        source.dispose()
        if (error) reject(error)
        else resolve(value)
      }
      const cancel = (error: Error) => {
        source.cancel()
        finish(error)
      }
      const aborted = () => cancel(new Error('Language server request cancelled'))
      const timer = setTimeout(() => {
        cancel(new Error(`Language server ${method} exceeded ${deadlineMs}ms`))
        void this.dispose(false)
      }, deadlineMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', aborted, { once: true })
      let response: Promise<unknown>
      try {
        response = this.connection.sendRequest(method, params, source.token)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      response.then(
        (value) => {
          if (!this.active) finish(new Error('Stale language server response'))
          else finish(undefined, value)
        },
        (error) => finish(error instanceof Error ? error : new Error(String(error)))
      )
    })
  }
  private abort(disposeConnection = true) {
    this.alive = false
    for (const cancel of [...this.pending])
      cancel(new Error('Language server exited or was replaced'))
    if (disposeConnection && !this.connectionDisposed) {
      this.connectionDisposed = true
      try {
        this.connection.dispose()
      } catch {
        /* already closed */
      }
    }
  }
  dispose(graceful = true): Promise<void> {
    if (this.closing) return this.closing
    // Bound shutdown independently of the ownership predicate, which has already been revoked.
    this.closing = (async () => {
      const shutdown =
        graceful && this.alive
          ? new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer)
                resolve()
              }
              const timer = setTimeout(finish, 1500)
              try {
                this.connection.sendRequest('shutdown', null).then(finish, finish)
              } catch {
                finish()
              }
            })
          : Promise.resolve()
      this.abort(false)
      await shutdown
      try {
        void this.connection.sendNotification('exit').catch(() => undefined)
      } catch {
        /* closed */
      }
      this.abort()
      try {
        this.proc.kill('SIGTERM')
      } catch {
        /* already exited */
      }
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc.removeListener('exit', done)
          try {
            this.proc.kill('SIGKILL')
          } catch {
            /* already exited */
          }
          resolve()
        }, 500)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        this.proc.once('exit', done)
      })
    })()
    return this.closing
  }
}
