type Waiter = {
  grant: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  cancel: () => void
}
const queues = new Map<string, { active: boolean; waiting: Waiter[] }>()
const aborted = () =>
  Object.assign(new Error('Aborted while waiting for project execution'), { name: 'AbortError' })
/** Mutating tools share a project lease across chat and background workers. */
export function acquireProjectWrite(project: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(aborted())
  const queue = queues.get(project) ?? { active: false, waiting: [] }
  queues.set(project, queue)
  const pump = () => {
    if (queue.active) return
    const next = queue.waiting.shift()
    if (!next) {
      queues.delete(project)
      return
    }
    next.signal?.removeEventListener('abort', next.cancel)
    if (next.signal?.aborted) {
      next.reject(aborted())
      pump()
      return
    }
    queue.active = true
    let released = false
    next.grant(() => {
      if (released) return
      released = true
      queue.active = false
      pump()
    })
  }
  return new Promise((grant, reject) => {
    const waiter: Waiter = {
      grant,
      reject,
      signal,
      cancel: () => {
        const index = queue.waiting.indexOf(waiter)
        if (index >= 0) queue.waiting.splice(index, 1)
        reject(aborted())
        pump()
      }
    }
    queue.waiting.push(waiter)
    signal?.addEventListener('abort', waiter.cancel, { once: true })
    pump()
  })
}
