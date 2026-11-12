import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { raceAbort, shouldJoinLoad, waitForJobEnd } from '../electron/main/services/llama-worker-channel'

// #518: after an aborted local step the GPU lease was released before the worker
// confirmed that the job ended, so the next request waited behind it in the worker.
describe('waitForJobEnd', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves true when the job ends first', async () => {
    let end: () => void = () => {}
    const result = waitForJobEnd((onEnd) => {
      end = onEnd
    }, 5_000)
    await vi.advanceTimersByTimeAsync(1_000)
    end()
    await expect(result).resolves.toBe(true)
  })

  it('resolves true when the job ends synchronously on subscribe', async () => {
    await expect(waitForJobEnd((onEnd) => onEnd(), 5_000)).resolves.toBe(true)
  })

  it('resolves false after the timeout, and ignores a late end', async () => {
    let end: () => void = () => {}
    const result = waitForJobEnd((onEnd) => {
      end = onEnd
    }, 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toBe(false)
    expect(() => end()).not.toThrow()
    await expect(result).resolves.toBe(false)
  })

  it('leaves no timer behind once the job ended', async () => {
    let end: () => void = () => {}
    const result = waitForJobEnd((onEnd) => {
      end = onEnd
    }, 5_000)
    end()
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('local stream waits for the worker before returning the lease', () => {
  const source = readFileSync('electron/main/services/builtin-model.ts', 'utf8')
  const stream = source.slice(
    source.indexOf('async function* streamBuiltinChatViaWorker'),
    source.indexOf('type WarmResult')
  )

  it('observes terminal messages even after the stream is done', () => {
    const onMsg = stream.slice(stream.indexOf('const onMsg'), stream.indexOf('const onFailure'))
    expect(onMsg.indexOf('workerEnded = true')).toBeGreaterThan(-1)
    expect(onMsg.indexOf('workerEnded = true')).toBeLessThan(onMsg.indexOf('if (done) return'))
  })

  it('only waits for a posted job that has not ended and did not time out', () => {
    expect(stream).toMatch(/if \(posted && !workerEnded && !timedOut\)/)
    expect(stream.match(/posted = true/g)).toHaveLength(2)
    expect(stream).toMatch(/waitForJobEnd\([\s\S]*WORKER_ABORT_ACK_MS\)/)
  })

  it('waits before the listeners are removed', () => {
    const fin = stream.slice(stream.lastIndexOf('} finally {'))
    expect(fin.indexOf('waitForJobEnd')).toBeLessThan(fin.indexOf("removeListener?.('message'"))
  })
})

describe('shared load cancellation (#523)', () => {
  it('matches both model path and requested context', () => {
    const pending = { path: 'model-a', requestedContext: 4096 }
    expect(shouldJoinLoad(pending, 'model-a', 4096)).toBe(true)
    expect(shouldJoinLoad(pending, 'model-b', 4096)).toBe(false)
    expect(shouldJoinLoad(pending, 'model-a', 8192)).toBe(false)
    expect(shouldJoinLoad(null, 'model-a', 4096)).toBe(false)
  })
  it('resolves a completed operation', async () => {
    await expect(raceAbort(Promise.resolve(42), new AbortController().signal)).resolves.toBe(42)
  })
  it('aborts the waiter but leaves the shared operation available to a later caller', async () => {
    let finish!: (value: number) => void
    const load = new Promise<number>(resolve => { finish = resolve })
    const abort = new AbortController()
    const first = raceAbort(load, abort.signal)
    abort.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    finish(42)
    await expect(raceAbort(load, new AbortController().signal)).resolves.toBe(42)
  })
  it('rejects an already-aborted signal', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(raceAbort(Promise.resolve(42), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
