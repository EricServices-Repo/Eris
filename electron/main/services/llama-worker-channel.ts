/** A worker disappearing must reject its caller, even when no final message arrives. */
export interface WorkerEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}
export class LocalModelWorkerError extends Error {
  readonly code = 'LOCAL_MODEL_WORKER_FAILED'
  constructor(detail: string) {
    super(`Local model worker ${detail}. Retry the request; the application remains available.`)
    this.name = 'LocalModelWorkerError'
  }
}
/** A long prefill gets its own deadline. Streaming must continue making progress. */
export function watchWorkerSilence(onTimeout: (phase: 'prefill' | 'generation') => void) {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => onTimeout('prefill'),
    180_000
  )
  return {
    chunk() {
      clearTimeout(timer)
      timer = setTimeout(() => onTimeout('generation'), 90_000)
    },
    stop() {
      clearTimeout(timer)
    }
  }
}

export function waitForWorkerMessage<T>(
  child: WorkerEventSource,
  predicate: (message: T) => boolean,
  signal?: AbortSignal,
  timeoutMs = 120000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('message', onMessage)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onMessage = (raw: unknown) => {
      const message = (raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw) as T
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onExit = (code: unknown) => {
      cleanup()
      reject(new LocalModelWorkerError(`exited (${String(code ?? 'unknown')})`))
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(
        new LocalModelWorkerError(
          `failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    }
    const onAbort = () => {
      cleanup()
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new LocalModelWorkerError('did not finish loading before its deadline'))
    }, timeoutMs)
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/**
 * Wait until the worker reports that a job has ended (#518). `subscribe` receives
 * the callback to call on the job's terminal message; it may call it at once.
 * Resolves true when the job ended, false when `timeoutMs` passed first. A late
 * end after the timeout does nothing.
 */
export function waitForJobEnd(
  subscribe: (onEnd: () => void) => void,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    subscribe(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}
