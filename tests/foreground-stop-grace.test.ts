import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForegroundTasks } from '../electron/main/services/foreground-tasks'

// #519: after Stop, the next chat waited until the stopped task returned, which
// could take as long as a slow tool, git or LSP call that ignores the signal.
describe('foreground queue stop grace period', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const deferred = () => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('detaches a stopped task that ignores the abort, and admits the next one', async () => {
    const onDetached = vi.fn()
    const queue = new ForegroundTasks(undefined, undefined, { stopGraceMs: 1_000, onDetached })
    const owner = {}
    const stuck = deferred()
    const first = queue.run('first', owner, () => stuck.promise)
    const firstResult = first.then(
      () => 'resolved',
      (error: Error) => error
    )
    const secondStarted = vi.fn()
    await vi.advanceTimersByTimeAsync(0)
    const second = queue.run('second', owner, async () => {
      secondStarted()
      return 'second done'
    })

    expect(queue.stop('first', owner)).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(secondStarted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    const error = await firstResult
    expect(error).toMatchObject({ name: 'AbortError', message: expect.stringMatching(/background/) })
    expect(onDetached).toHaveBeenCalledWith('first')
    await expect(second).resolves.toBe('second done')
    expect(secondStarted).toHaveBeenCalledTimes(1)
    expect(queue.detachedCount).toBe(1)

    // The stopped work finally fails; that is neither unhandled nor counted.
    stuck.reject(Object.assign(new Error('late'), { name: 'AbortError' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.detachedCount).toBe(0)
  })

  it('leaves a task that honours the abort within the grace period unchanged', async () => {
    const onDetached = vi.fn()
    const queue = new ForegroundTasks(undefined, undefined, { stopGraceMs: 1_000, onDetached })
    const owner = {}
    const run = queue.run('task', owner, (controller) =>
      new Promise<string>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          setTimeout(() => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), 200)
        )
      })
    )
    const result = run.then(
      () => null,
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(0)
    queue.stop('task', owner)
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toBe('Aborted')
    expect(onDetached).not.toHaveBeenCalled()
    expect(queue.detachedCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never detaches a task that was not stopped, however long it runs', async () => {
    const onDetached = vi.fn()
    const queue = new ForegroundTasks(undefined, undefined, { stopGraceMs: 1_000, onDetached })
    const slow = deferred()
    const run = queue.run('slow', {}, async () => {
      await slow.promise
      return 'finished'
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(onDetached).not.toHaveBeenCalled()
    expect(queue.size).toBe(1)
    slow.resolve()
    await expect(run).resolves.toBe('finished')
  })

  it('still cancels a queued task immediately', async () => {
    const queue = new ForegroundTasks(undefined, undefined, { stopGraceMs: 1_000 })
    const owner = {}
    const blocker = deferred()
    const first = queue.run('first', owner, () => blocker.promise)
    await vi.advanceTimersByTimeAsync(0)
    const work = vi.fn()
    const queued = queue.run('queued', owner, async () => work())
    const queuedResult = queued.then(
      () => null,
      (error: Error) => error.message
    )
    queue.stop('queued', owner)
    await vi.advanceTimersByTimeAsync(0)
    expect(await queuedResult).toBe('Queued task cancelled')
    expect(work).not.toHaveBeenCalled()
    blocker.resolve()
    await first
  })
})
