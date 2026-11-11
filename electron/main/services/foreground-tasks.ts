import { runWithChatActivity } from './chat-activity'
import { chatPublisher, type ChatEventTarget } from './chat-events'
import type { TaskPhaseEvent } from '../../../src/shared/task-timeline'
import { recordChatJobEvent } from './chat-job-controller'
import { logWarn } from './logger'
/** How long a stopped task may keep unwinding before the next task is admitted (#519). */
export const STOP_GRACE_MS = 15_000
type QueueState = {
  id: string
  phase: 'queued' | 'admitted'
  position: number
  blockedBy: string | null
  /** The window that submitted the task; receives its queued phase (#520). */
  owner: unknown
}
/** FIFO admission with immediate queued cancellation and task-owned execution cleanup. */
export class ForegroundTasks {
  private tasks = new Map<
    string,
    { controller: AbortController; owner: unknown; running: boolean }
  >()
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  /** Stopped tasks that overran the grace period and still run in the background. */
  private detached = new Set<string>()
  constructor(
    private observe?: (state: QueueState) => void,
    private phase?: (id: string, event: TaskPhaseEvent, owner: unknown) => void,
    private options: { stopGraceMs?: number; onDetached?: (id: string) => void } = {}
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
          blockedBy: t.running ? null : running,
          owner: t.owner
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
    const idle = this.tasks.size === 0
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
      if (idle) await previous
      else
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
      return await this.runUntilStoppedOrDone(id, controller, () =>
        runWithChatActivity(
          id,
          (event) => this.phase?.(id, event, owner),
          () => work(controller)
        )
      )
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      this.tasks.delete(id)
      release()
      this.notify()
    }
  }
  /**
   * Run admitted work. Once the task is stopped it gets `stopGraceMs` to return;
   * after that it is detached: the queue is released so the next chat can start,
   * and the work keeps unwinding in the background (#519).
   *
   * Only a stop (abort) starts the grace timer. A task that is never stopped is
   * never detached, however long it runs.
   */
  private async runUntilStoppedOrDone<T>(
    id: string,
    controller: AbortController,
    start: () => Promise<T>
  ): Promise<T> {
    const outcome = start()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let arm: () => void = () => {}
    const overrun = new Promise<'overrun'>((resolve) => {
      arm = () => {
        graceTimer = setTimeout(() => resolve('overrun'), this.options.stopGraceMs ?? STOP_GRACE_MS)
      }
      if (controller.signal.aborted) arm()
      else controller.signal.addEventListener('abort', arm, { once: true })
    })
    const settled = outcome.then((value) => ({ value }))
    try {
      const first = await Promise.race([settled, overrun])
      if (first !== 'overrun') return first.value
      // Stopped but not returned. Let the next task start; keep watching this one.
      this.detached.add(id)
      // Both promises may still reject; they must not become unhandled rejections.
      void settled.catch(() => undefined)
      void outcome.catch(() => undefined).finally(() => this.detached.delete(id))
      try {
        this.options.onDetached?.(id)
      } catch {
        /* observers cannot own the queue */
      }
      throw Object.assign(new Error('Stopped. Cleanup is finishing in the background.'), {
        name: 'AbortError'
      })
    } finally {
      clearTimeout(graceTimer)
      controller.signal.removeEventListener('abort', arm)
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
  /** Stopped tasks still unwinding after their queue slot was released. */
  get detachedCount() {
    return this.detached.size
  }
}
const isEventTarget = (owner: unknown): owner is ChatEventTarget =>
  Boolean(owner) &&
  typeof (owner as ChatEventTarget).send === 'function' &&
  typeof (owner as ChatEventTarget).isDestroyed === 'function'

/**
 * Queue observer for the app's foreground queue. A queued task's phase goes to its
 * window so the chat shows "Queued (#n)" instead of "Working…" (#520). The admitted
 * state stays record-only: notify() re-reports the running task whenever the queue
 * changes, and sending it would flip the renderer's status back to "Starting" in
 * the middle of a run.
 */
export function publishQueueState(state: QueueState): void {
  const payload = {
    phase: state.phase,
    queuePosition: state.position,
    blockedBy: state.blockedBy,
    source: 'foreground',
    reason:
      state.phase === 'queued'
        ? 'Waiting for the previous task to finish'
        : 'Foreground execution admitted'
  }
  // Every task is reported as queued for a moment before admission, even with an
  // idle queue; only a task actually waiting behind another one is shown as queued.
  if (state.phase === 'queued' && state.blockedBy !== null && isEventTarget(state.owner))
    // chatPublisher records the job event itself, so the record matches the other branch.
    chatPublisher(state.id, () => state.owner as ChatEventTarget)('chat:phase', {
      requestId: state.id,
      ...payload
    })
  else recordChatJobEvent(state.id, 'chat:phase', payload)
}

export const foregroundTasks = new ForegroundTasks(
  publishQueueState,
  (id, event, owner) =>
    chatPublisher(id, () => owner as ChatEventTarget)('chat:phase', { requestId: id, ...event }),
  {
    onDetached: (id) =>
      logWarn('Stopped chat task is still unwinding; queue released', { taskId: id })
  }
)
