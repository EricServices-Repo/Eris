import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { createAbortLedger } from '../electron/main/services/llama-abort-ledger'

// #517: an abort that reached the worker while its job was still queued was lost,
// and the job later ran a full generation that nobody was listening to.
describe('llama worker abort ledger', () => {
  it('aborts a running job', () => {
    const ledger = createAbortLedger()
    const controller = ledger.start('a')!
    ledger.abort('a')
    expect(controller.signal.aborted).toBe(true)
    expect(ledger.pendingCount).toBe(0)
  })

  it('refuses to start a job that was aborted while queued', () => {
    const ledger = createAbortLedger()
    ledger.abort('queued')
    expect(ledger.pendingCount).toBe(1)
    expect(ledger.start('queued')).toBeNull()
    expect(ledger.pendingCount).toBe(0)
    const next = ledger.start('next')
    expect(next).not.toBeNull()
    expect(next!.signal.aborted).toBe(false)
  })

  it('ignores an abort after finish and leaves new jobs alone', () => {
    const ledger = createAbortLedger()
    ledger.start('done')
    ledger.finish('done')
    expect(() => ledger.abort('done')).not.toThrow()
    const fresh = ledger.start('fresh')!
    expect(fresh.signal.aborted).toBe(false)
  })

  it('bounds the remembered early aborts, evicting the oldest', () => {
    const ledger = createAbortLedger(3)
    for (const id of ['1', '2', '3', '4', '5']) ledger.abort(id)
    expect(ledger.pendingCount).toBe(3)
    expect(ledger.start('1')).not.toBeNull()
    expect(ledger.start('5')).toBeNull()
  })

  it('abortAll aborts every running job', () => {
    const ledger = createAbortLedger()
    const a = ledger.start('a')!
    const b = ledger.start('b')!
    ledger.abortAll()
    expect(a.signal.aborted && b.signal.aborted).toBe(true)
  })

  it('is the only cancellation path in the worker', () => {
    const source = readFileSync('electron/main/llama-worker.ts', 'utf8')
    expect(source).not.toMatch(/abortControllers/)
    expect(source.match(/aborts\.start\(msg\.id\)/g)).toHaveLength(2)
  })
})
