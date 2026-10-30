/** Await shared work without transferring a caller's cancellation to other consumers. */
export function abortable<T>(
  promise: Promise<T>,
  signals: Array<AbortSignal | undefined>
): Promise<T> {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => active.forEach((signal) => signal.removeEventListener('abort', abort))
    const abort = () => {
      cleanup()
      reject(new DOMException('Conversation hydration cancelled', 'AbortError'))
    }
    // Always attach handlers, even if an already-aborted consumer never awaits work.
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (active.some((signal) => signal.aborted)) {
      abort()
      return
    }
    active.forEach((signal) => signal.addEventListener('abort', abort, { once: true }))
  })
}
export class SharedHydration {
  readonly controller = new AbortController()
  readonly done: Promise<void>
  private consumers = 0
  private settled = false
  constructor(run: (signal: AbortSignal) => Promise<void>) {
    this.done = Promise.resolve()
      .then(() => run(this.controller.signal))
      .finally(() => {
        this.settled = true
      })
    // The last consumer may detach before the underlying worker RPC settles.
    void this.done.catch(() => {})
  }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.consumers >= 64) throw new Error('Too many conversation hydration consumers')
    this.consumers++
    try {
      await abortable(this.done, [signal, this.controller.signal])
    } finally {
      this.consumers--
      if (!this.consumers && !this.settled) this.controller.abort()
    }
  }
}
