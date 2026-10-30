export type HydrationPriority = 'foreground' | 'background'
type Job = {
  key: string
  namespace: string
  priority: HydrationPriority
  run: () => Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  signal: AbortSignal
  detach: () => void
}
/** Two worker streams, only one speculative stream, and eight queued tasks.
 * Active RPCs retain their reservation until they settle, even on caller abort.
 */
export class HydrationScheduler {
  private active = new Set<Job>()
  private queue: Job[] = []
  private lastNamespace: string | undefined
  get counts() {
    return { active: this.active.size, queued: this.queue.length }
  }
  promote(key: string) {
    for (const job of [...this.active, ...this.queue])
      if (job.key === key) job.priority = 'foreground'
    this.drain()
  }
  discardSpeculative() {
    const job = [...this.queue].reverse().find((candidate) => candidate.priority === 'background')
    if (!job) return undefined
    this.remove(
      job,
      new DOMException('Speculative context warm superseded by foreground work', 'AbortError')
    )
    return job.key
  }
  run(
    key: string,
    namespace: string,
    priority: HydrationPriority,
    signal: AbortSignal,
    run: () => Promise<void>
  ): Promise<void> {
    signal.throwIfAborted()
    if (this.queue.length >= 8 && (priority !== 'foreground' || !this.discardSpeculative()))
      return Promise.reject(new Error('Conversation hydration queue is full'))
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        // Never free an active slot before its outstanding worker call settles.
        if (this.queue.includes(job)) {
          this.remove(job, signal.reason)
          this.drain()
        }
      }
      const job: Job = {
        key,
        namespace,
        priority,
        run,
        resolve,
        reject,
        signal,
        detach: () => signal.removeEventListener('abort', abort)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.queue.push(job)
      this.drain()
    })
  }
  private remove(job: Job, error: unknown) {
    this.queue.splice(this.queue.indexOf(job), 1)
    job.detach()
    job.reject(error)
  }
  private drain() {
    while (this.active.size < 2) {
      const foreground = this.queue.filter((job) => job.priority === 'foreground')
      const backgroundAllowed = ![...this.active].some((job) => job.priority === 'background')
      const eligible = foreground.length ? foreground : backgroundAllowed ? this.queue : []
      const next = eligible.find((job) => job.namespace !== this.lastNamespace) ?? eligible[0]
      if (!next) return
      this.queue.splice(this.queue.indexOf(next), 1)
      this.lastNamespace = next.namespace
      this.active.add(next)
      void Promise.resolve()
        .then(() => {
          next.signal.throwIfAborted()
          return next.run()
        })
        .then(next.resolve, next.reject)
        .finally(() => {
          next.detach()
          this.active.delete(next)
          this.drain()
        })
    }
  }
}
