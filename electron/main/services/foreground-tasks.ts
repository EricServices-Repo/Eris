import { runWithChatActivity } from './chat-activity'
import { chatPublisher, type ChatEventTarget } from './chat-events'
import type { TaskPhaseEvent } from '../../../src/shared/task-timeline'
import { recordChatJobEvent } from './chat-job-controller'
type QueueState = {
  id: string
  phase: 'queued' | 'admitted'
  position: number
  blockedBy: string | null
}
/** FIFO admission with immediate queued cancellation and task-owned execution cleanup. */
export class ForegroundTasks {
  private tasks = new Map<
    string,
    { controller: AbortController; owner: unknown; running: boolean }
  >()
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  constructor(
    private observe?: (state: QueueState) => void,
    private phase?: (id: string, event: TaskPhaseEvent, owner: unknown) => void
  ) {}
  private notify() {
    const running = [...this.tasks].find(([, t]) => t.running)?.[0] ?? null
    let position = 0
    for (const [id, t] of this.tasks) {
      try {
        this.observe?.({
          id,
          phase: t.running ? 'admitted' : 'queued',
          position: t.running ? 0 : ++position,
          blockedBy: t.running ? null : running
        })
      } catch {
        /* observers cannot own the queue */
      }
    }
  }
  async run<T>(
    id: string,
    owner: unknown,
    work: (controller: AbortController) => Promise<T>
  ): Promise<T> {
    if (this.closing) throw new Error('Eris is closing; task was not started')
    if (this.tasks.has(id)) throw new Error('Task is already admitted')
    if (this.tasks.size >= 50) throw new Error('The foreground queue is full')
    const controller = new AbortController(),
      previous = this.tail
    let release!: () => void
    const completion = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tail = previous.then(() => completion)
    this.tasks.set(id, { controller, owner, running: false })
    this.notify()
    let cancel: () => void = () => {}
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          cancel = () =>
            reject(Object.assign(new Error('Queued task cancelled'), { name: 'AbortError' }))
          controller.signal.addEventListener('abort', cancel, { once: true })
        })
      ])
      controller.signal.removeEventListener('abort', cancel)
      if (controller.signal.aborted)
        throw Object.assign(new Error('Queued task cancelled'), { name: 'AbortError' })
      this.tasks.get(id)!.running = true
      this.notify()
      return await runWithChatActivity(
        id,
        (event) => this.phase?.(id, event, owner),
        () => work(controller)
      )
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      this.tasks.delete(id)
      release()
      this.notify()
    }
  }
  stop(id: string, owner: unknown) {
    const task = this.tasks.get(id)
    if (!task || task.owner !== owner) return false
    task.controller.abort()
    return true
  }
  close() {
    this.closing = true
    for (const task of this.tasks.values()) task.controller.abort()
  }
  get size() {
    return this.tasks.size
  }
}
export const foregroundTasks = new ForegroundTasks(
  (state) =>
    recordChatJobEvent(state.id, 'chat:phase', {
      phase: state.phase,
      queuePosition: state.position,
      blockedBy: state.blockedBy,
      source: 'foreground',
      reason:
        state.phase === 'queued'
          ? 'Waiting for earlier foreground work'
          : 'Foreground execution admitted'
    }),
  (id, event, owner) =>
    chatPublisher(id, () => owner as ChatEventTarget)('chat:phase', { requestId: id, ...event })
)
