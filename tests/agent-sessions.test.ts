import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendSessionStep,
  branchAgentSession,
  compactWorkerMessagesForSession,
  createAgentSession,
  listSessionSteps,
  loadSessionStep
} from '../electron/main/services/agent-sessions'
import {
  createCheckpoint,
  getCheckpointOpCount,
  recordWriteOp,
  restoreCheckpointThrough,
  snapshotBeforeWrite
} from '../electron/main/services/checkpoints'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eris-session-'))
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
})

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('agent sessions', () => {
  it('persists steps and supports branch-from-step', () => {
    const session = createAgentSession(ws, {
      requestId: 'req-1',
      goal: 'Add a helper',
      agentId: 'composer',
      mode: 'agent',
      checkpointId: 'ckpt'
    })
    appendSessionStep(ws, session.id, {
      step: 1,
      opThrough: 0,
      summary: 'Listed tree',
      actionLog: ['Listed tree'],
      filesTouched: [],
      workerMessages: [{ role: 'user', content: 'hi' }]
    })
    appendSessionStep(ws, session.id, {
      step: 2,
      opThrough: 1,
      summary: 'Wrote src/a.ts',
      actionLog: ['Listed tree', 'Wrote src/a.ts'],
      filesTouched: ['src/a.ts'],
      workerMessages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'DONE' }
      ]
    })
    const steps = listSessionSteps(ws, session.id)
    expect(steps.map((s) => s.step)).toEqual([1, 2])
    expect(loadSessionStep(ws, session.id, 2)?.filesTouched).toContain('src/a.ts')

    const branched = branchAgentSession(ws, session.id, 1, 'req-2')
    expect(branched?.parentSessionId).toBe(session.id)
    expect(branched?.branchFromStep).toBe(1)
    expect(listSessionSteps(ws, branched!.id)[0]?.step).toBe(1)
  })

  it('compacts oversized worker transcripts', () => {
    const big = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i} ` + 'x'.repeat(2000)
    }))
    const compact = compactWorkerMessagesForSession(big, 8_000)
    expect(compact.length).toBeLessThan(big.length)
    expect(compact[0]?.content).toMatch(/trimmed/i)
  })
})

describe('checkpoint through-rewind', () => {
  it('undoes ops after keepOps and truncates the log', () => {
    const ck = createCheckpoint(ws)
    const before1 = snapshotBeforeWrite(ws, ck.id, 'src/a.ts')
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 2\n', 'utf8')
    recordWriteOp(ws, ck.id, 'src/a.ts', before1, 'export const a = 2\n')

    const before2 = snapshotBeforeWrite(ws, ck.id, 'src/b.ts')
    writeFileSync(join(ws, 'src', 'b.ts'), 'export const b = 1\n', 'utf8')
    recordWriteOp(ws, ck.id, 'src/b.ts', before2, 'export const b = 1\n')

    expect(getCheckpointOpCount(ws, ck.id)).toBe(2)

    const result = restoreCheckpointThrough(ws, ck.id, 1)
    expect(result.kept).toBe(1)
    expect(result.restored).toBe(1)
    expect(getCheckpointOpCount(ws, ck.id)).toBe(1)
    expect(readFileSync(join(ws, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(() => readFileSync(join(ws, 'src', 'b.ts'), 'utf8')).toThrow()
  })
})

import { EventEmitter } from 'events'
import { waitForWorkerMessage } from '../electron/main/services/llama-worker-channel'
describe('native model worker response lifecycle', () => {
  it('rejects on exit and removes listeners from the original worker', async () => {
    const worker = new EventEmitter()
    const waiting = waitForWorkerMessage<{ type: string }>(worker, (m) => m.type === 'loaded')
    worker.emit('exit', 1)
    await expect(waiting).rejects.toMatchObject({ code: 'LOCAL_MODEL_WORKER_FAILED' })
    expect(worker.eventNames()).toEqual([])
  })
  it('honors cancellation during load, including a signal already cancelled', async () => {
    for (const before of [true, false]) {
      const worker = new EventEmitter()
      const controller = new AbortController()
      if (before) controller.abort()
      const waiting = waitForWorkerMessage(worker, () => true, controller.signal)
      if (!before) controller.abort()
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      expect(worker.eventNames()).toEqual([])
    }
  })
  it('accepts only the matching message and clears its finite deadline', async () => {
    const worker = new EventEmitter()
    const waiting = waitForWorkerMessage<{ id: string }>(worker, (m) => m.id === 'matching')
    worker.emit('message', { id: 'other' })
    worker.emit('message', { data: { id: 'matching' } })
    await expect(waiting).resolves.toEqual({ id: 'matching' })
    expect(worker.eventNames()).toEqual([])
  })
})
