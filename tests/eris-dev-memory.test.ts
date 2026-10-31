import { memoryForDestination } from '../electron/main/services/agent/context-compiler'
import {
  runInDiagnosticsScope,
  SIMULATED_MODEL_REF
} from '../electron/main/services/model-transport'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import { closeChatDatabases } from '../electron/main/services/chat-database'
import { DevMemoryReplay, finishMemoryTrace } from '../electron/dev/memory-replay'
import { captureQuestion } from '../electron/dev/capture'
import { prepareQuestions } from '../electron/dev/questions'
import type { DevQuestion } from '../src/shared/eris-dev'
let root: string
const signal = () => new AbortController().signal
const question = (i: number, text: string): DevQuestion => ({
  id: `q${i}`,
  text,
  sourceLine: i + 1,
  occurrence: 1
})
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eris-memory-replay-test-'))
  vi.mocked(workspaceRequest).mockImplementation(
    async (request) => (await handleWorkspaceRequest(request)) as never
  )
})
afterEach(() => {
  closeChatDatabases()
  rmSync(root, { recursive: true, force: true })
})
it('preserves explicit memory labels and refuses malformed imported controls', () => {
  const imported = prepareQuestions(
    JSON.stringify([
      {
        id: 'first',
        text: 'Remember currency CAD',
        memory: { scriptedResponse: 'Noted', expectedSourceIds: ['old:u'] }
      }
    ]),
    '.json',
    'memory'
  )
  expect(imported.questions[0].memory?.scriptedResponse).toBe('Noted')
  expect(() =>
    prepareQuestions('[{"text":"test","memory":{"rewindMessages":-1}}]', '.json', 'bad')
  ).toThrow()
})
it('sends a buried source through the production compiler without inventing a simulated model answer', async () => {
  const replay = new DevMemoryReplay(root, 'run', 'stateful', 30, false)
  for (let i = 0; i < 15; i++) {
    const q = question(
      i,
      i === 0 ? 'Remember: booking currency must be CAD' : `Routine unrelated status ${i}`
    )
    const prepared = await replay.prepare(i, q, signal())
    const result = await captureQuestion(i, q.text, null, 8192, 'ask', signal(), {
      question: { ...q, history: prepared.history },
      threadId: prepared.threadId,
      conversationMemory: prepared.prompt
    })
    await replay.commit(i, q, result, signal())
  }
  const q = {
    ...question(15, 'What booking currency is required?'),
    memory: { expectedSourceIds: ['q0:u'] }
  }
  const prepared = await replay.prepare(15, q, signal())
  expect(prepared.trace.retrievedSourceIds).toContain('q0:u')
  const result = await captureQuestion(15, q.text, null, 8192, 'ask', signal(), {
    question: { ...q, history: prepared.history },
    threadId: prepared.threadId,
    conversationMemory: prepared.prompt
  })
  expect(
    result.requests.some((request) =>
      JSON.stringify(request.messages).includes('currency must be CAD')
    )
  ).toBe(true)
  expect(result.response).toBeNull()
  const trace = finishMemoryTrace(prepared.trace, result)
  expect(trace.actualModelCalls).toBe(0)
  expect(trace.missingExpectedSourceIds).toEqual([])
  await replay.dispose()
  expect(existsSync(root)).toBe(false)
})
it('isolates episodes and reports pressure and rewind as deliberate injected state', async () => {
  const replay = new DevMemoryReplay(root, 'pressure', 'pressure', 2, false)
  const q = question(0, 'Remember: private currency CAD')
  await replay.prepare(0, q, signal())
  const result = await captureQuestion(0, q.text, null, 8192, 'ask', signal())
  await replay.commit(0, q, result, signal())
  const pressure = await replay.prepare(1, question(1, 'What currency?'), signal())
  expect(pressure.trace.pressureInjected).toBe(true)
  expect(pressure.trace.estimatedBytes).toBe(0)
  const next = await replay.prepare(2, question(2, 'What currency?'), signal())
  expect(next.history).toEqual([])
  expect(next.prompt.text).not.toContain('private currency')
  const rewound = await replay.prepare(
    3,
    { ...question(3, 'Continue'), memory: { rewindMessages: 0, expectedSourceIds: [] } },
    signal()
  )
  expect(rewound.history).toEqual([])
  await replay.dispose()
})

it('permits simulated local-only recall only inside its guarded diagnostics transport', async () => {
  const prompt = { text: 'private memory', allowRemote: false } as never
  expect(memoryForDestination(prompt, SIMULATED_MODEL_REF).memory).toBeUndefined()
  await runInDiagnosticsScope(
    {
      runId: 'private-test',
      onBlockedEffect: () => {},
      mode: 'simulated',
      adapter: {
        kind: 'scripted',
        async *stream() {
          yield ''
        }
      }
    },
    async () => {
      expect(memoryForDestination(prompt, SIMULATED_MODEL_REF).memory).toBe('private memory')
      expect(memoryForDestination(prompt, 'remote:model').memory).toBeUndefined()
    }
  )
})
