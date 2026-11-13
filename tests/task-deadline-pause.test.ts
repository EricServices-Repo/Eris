import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskDeadline } from '../electron/main/services/task-deadline'

describe('task deadline user waits (#525)', () => {
  afterEach(() => vi.useRealTimers())
  it('resumes with the remaining time after a long pause', async () => {
    vi.useFakeTimers()
    const deadline = createTaskDeadline(undefined, 10_000)
    await vi.advanceTimersByTimeAsync(4_000)
    deadline.pause()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deadline.signal.aborted).toBe(false)
    deadline.resume()
    await vi.advanceTimersByTimeAsync(5_999)
    expect(deadline.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(deadline.stopReason()).toBe('timeout')
    deadline.dispose()
  })
  it('honors nested pauses and parent cancellation while paused', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const deadline = createTaskDeadline(parent.signal, 10_000)
    deadline.pause()
    deadline.pause()
    deadline.resume()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(deadline.signal.aborted).toBe(false)
    parent.abort()
    expect(deadline.stopReason()).toBe('cancelled')
    deadline.resume()
    deadline.dispose()
  })
})
