/** Foreground tasks queue explicitly; another thread never implicitly aborts a task. */
export class ForegroundTasks {
  private tasks = new Map<string, { controller: AbortController; owner: unknown }>()
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  async run<T>(
    id: string,
    owner: unknown,
    work: (controller: AbortController) => Promise<T>
  ): Promise<T> {
    if (this.closing) throw new Error('Eris is closing; task was not started')
    if (this.tasks.has(id)) throw new Error('Task is already admitted')
    if (this.tasks.size >= 50) throw new Error('The foreground queue is full')
    const controller = new AbortController()
    this.tasks.set(id, { controller, owner })
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      if (controller.signal.aborted)
        throw Object.assign(new Error('Queued task cancelled'), { name: 'AbortError' })
      return await work(controller)
    } finally {
      this.tasks.delete(id)
      release()
    }
  }
  stop(id: string, owner: unknown): boolean {
    const task = this.tasks.get(id)
    if (!task || task.owner !== owner) return false
    task.controller.abort()
    return true
  }
  close(): void {
    this.closing = true
    for (const task of this.tasks.values()) task.controller.abort()
  }
  get size(): number {
    return this.tasks.size
  }
}
export const foregroundTasks = new ForegroundTasks()
