/** Why a bounded task stopped before its work finished. */
export type TaskStopReason = 'timeout' | 'cancelled'

export interface TaskDeadline {
  /** Aborts on parent cancellation or when the deadline passes. */
  readonly signal: AbortSignal
  readonly timeoutMs: number
  stopReason(): TaskStopReason | null
  dispose(): void
}

/** Stop delivery from an abort-ignoring model adapter; never used to abandon filesystem effects. */
export async function* modelStreamWithAbort<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T, void, unknown> {
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  const check = () => { if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' }) }
  try {
    check()
    for (;;) {
      const next = iterator.next()
      next.catch(() => undefined)
      const result = await Promise.race([next, aborted])
      check()
      if (result.done) { completed = true; return }
      yield result.value
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!completed) void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined)
  }
}

/**
 * Child abort scope for one task: linked to the run's cancellation signal and
 * aborted after `timeoutMs`. The stop reason records which one fired first.
 */
export function createTaskDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number
): TaskDeadline {
  const controller = new AbortController()
  let reason: TaskStopReason | null = null
  const stop = (next: TaskStopReason) => {
    if (reason) return
    reason = next
    controller.abort(next)
  }
  const onParentAbort = () => stop('cancelled')
  if (parent?.aborted) stop('cancelled')
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => stop('timeout'), timeoutMs)
  return {
    signal: controller.signal,
    timeoutMs,
    stopReason: () => reason,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    }
  }
}

/**
 * Consume `source` until it finishes or the deadline stops it. A producer that
 * ignores its abort signal cannot hold the task past the deadline: the pending
 * step is abandoned and the iterator is asked to return in the background.
 */
export async function drainUntilStopped<T>(
  source: AsyncIterable<T>,
  deadline: TaskDeadline,
  onItem: (item: T) => void
): Promise<'completed' | TaskStopReason> {
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  let onStop: (() => void) | undefined
  const stopped = new Promise<'stopped'>((resolve) => {
    onStop = () => resolve('stopped')
    if (deadline.signal.aborted) resolve('stopped')
    else deadline.signal.addEventListener('abort', onStop, { once: true })
  })
  try {
    for (;;) {
      const next = iterator.next()
      // The abandoned step may still reject with AbortError after we stop.
      next.catch(() => undefined)
      const step = await Promise.race([next, stopped])
      if (step === 'stopped') {
        return deadline.stopReason() ?? 'cancelled'
      }
      if (step.done) {
        completed = true
        return 'completed'
      }
      onItem(step.value)
    }
  } catch (error) {
    const reason = deadline.stopReason()
    if (reason) return reason
    throw error
  } finally {
    if (onStop) deadline.signal.removeEventListener('abort', onStop)
    // Also close a producer when an output-limit/validation callback throws.
    // An abort-ignoring producer must never delay the caller's terminal result.
    if (!completed) void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined)
  }
}
