/**
 * Tracks chat jobs in the model worker so an abort is never lost, whenever it
 * arrives (#517).
 *
 * The worker runs load and chat jobs one at a time through a promise chain, but
 * handles `abort` messages immediately. A job's AbortController used to be
 * created only when the job reached the front of the chain, so an abort that
 * arrived while the job was still queued found nothing to cancel, and the job
 * later ran a full generation nobody was listening to. The ledger remembers
 * those early aborts and refuses to start the job.
 *
 * No Electron imports: this is loaded by the utilityProcess and by tests.
 */
export type AbortLedger = {
  /** Call when a job starts. Returns null when it was cancelled while queued. */
  start(id: string): AbortController | null
  /** Call when a job ends, however it ends. */
  finish(id: string): void
  /** Abort a running job, or remember the id so the job never starts. */
  abort(id: string): void
  /** Abort every running job (worker disposal). Remembered early aborts are kept. */
  abortAll(): void
  /** Number of early aborts remembered; for tests and diagnostics. */
  readonly pendingCount: number
}

export function createAbortLedger(maxRemembered = 256): AbortLedger {
  const running = new Map<string, AbortController>()
  // Insertion-ordered, so the oldest entry is evicted first.
  const cancelledBeforeStart = new Set<string>()
  return {
    start(id) {
      if (cancelledBeforeStart.delete(id)) return null
      const controller = new AbortController()
      running.set(id, controller)
      return controller
    },
    finish(id) {
      running.delete(id)
    },
    abort(id) {
      const controller = running.get(id)
      if (controller) {
        controller.abort()
        return
      }
      cancelledBeforeStart.add(id)
      // An abort for an id that already finished (or never existed) is remembered
      // too; bound the set so such ids cannot grow it without limit.
      while (cancelledBeforeStart.size > maxRemembered) {
        const oldest = cancelledBeforeStart.values().next().value
        if (oldest === undefined) break
        cancelledBeforeStart.delete(oldest)
      }
    },
    abortAll() {
      for (const controller of running.values()) controller.abort()
      running.clear()
    },
    get pendingCount() {
      return cancelledBeforeStart.size
    }
  }
}
