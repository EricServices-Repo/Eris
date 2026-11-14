import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchForStall } from '../electron/main/services/chat-stall-watch'

describe('chat stall watcher (#524)', () => {
  afterEach(() => vi.useRealTimers())
  it('reports every quiet interval, resets on activity and stops cleanly', async () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const watch = watchForStall(45_000, onStall)
    await vi.advanceTimersByTimeAsync(44_999)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onStall).toHaveBeenCalledWith(45_000)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(onStall).toHaveBeenCalledTimes(2)
    watch.touch()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(onStall).toHaveBeenCalledTimes(3)
    expect(onStall).toHaveBeenLastCalledWith(45_000)
    watch.stop()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(onStall).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
