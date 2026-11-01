import { afterEach, describe, expect, it, vi } from 'vitest'

const model = vi.hoisted(() => ({
  calls: [] as Array<{ purpose?: string }>,
  reply: 'x'.repeat(50)
}))
vi.mock('../electron/main/services/agent/stream', async (original) => ({
  ...(await original<typeof import('../electron/main/services/agent/stream')>()),
  collectModelText: async (options: { purpose?: string }) => {
    model.calls.push(options)
    return model.reply
  }
}))

import {
  compactAgentMessages,
  estimateTokens,
  microCompactAgentMessages
} from '../electron/main/services/agent/compaction'
import { RunJournal } from '../electron/main/services/agent/run-journal'
import type { AgentChatMessage } from '../electron/main/services/agent/types'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import { ContextMemorySettingsSchema } from '../src/shared/context-memory'

const journals: RunJournal[] = []
function journal(id = 'run') {
  const store = new ContextMemoryStore()
  store.configure(ContextMemorySettingsSchema.parse({ maxMemoryMiB: 512 }))
  const created = new RunJournal({ runId: id, taskId: id, memoryKey: id }, store)
  journals.push(created)
  return created
}
const output = (index: number) =>
  `exit ${index}\n${`filler ${index}\n`.repeat(400)}final line ${index}`
const refOf = (content: string) => content.match(/^\[ref:([0-9a-f]+) /)?.[1] ?? ''

async function run(target: RunJournal, count: number, prefix = 'c'): Promise<AgentChatMessage[]> {
  const messages: AgentChatMessage[] = [{ role: 'system', content: 'system prompt' }]
  for (let index = 0; index < count; index++) {
    const id = `${prefix}${index}`
    const content = output(index)
    await target.append({
      toolName: 'run',
      toolCallId: id,
      args: { command: `npm test ${index}` },
      content
    })
    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name: 'run', arguments: '{}' } }]
      } as AgentChatMessage,
      { role: 'tool', tool_call_id: id, content } as AgentChatMessage
    )
  }
  return messages
}

const compact = (
  messages: AgentChatMessage[],
  evidence: RunJournal | undefined,
  extra: Partial<Parameters<typeof compactAgentMessages>[0]> = {}
) =>
  compactAgentMessages({
    messages,
    goal: 'Fix the tests',
    filesTouched: [],
    actionLog: ['Ran npm test'],
    treeSnapshot: null,
    priorMemory: null,
    settings: getDefaults(),
    liteModel: 'builtin:composer-lite',
    temperature: 0,
    getSecret: () => null,
    evidence,
    ...extra
  })

afterEach(() => {
  for (const item of journals.splice(0)) item.close()
  model.calls.length = 0
})

describe('micro eviction', () => {
  it('makes every evicted result in a 200-result run recoverable, for no model calls', async () => {
    const target = journal()
    const messages = await run(target, 200)
    const result = microCompactAgentMessages(messages, 2_000, target)
    const stubbed = result.messages.filter((message) => refOf(message.content))
    expect(stubbed.length).toBeGreaterThan(190)
    expect(result.evicted).toBe(stubbed.length)
    for (const message of stubbed) {
      const read = await target.read(refOf(message.content))
      const id = (message as { tool_call_id: string }).tool_call_id
      expect(read).toMatchObject({ status: 'found', content: output(Number(id.slice(1))) })
    }
    expect(model.calls).toHaveLength(0)
  })

  it('writes a stub that says what it replaced and how to read it', async () => {
    const target = journal()
    const messages = await run(target, 8)
    const stub = microCompactAgentMessages(messages, 300, target).messages.find((message) =>
      refOf(message.content)
    )!.content
    const ref = refOf(stub)
    expect(stub).toContain('run {"command":"npm test')
    expect(stub).toMatch(/\d+ bytes/)
    expect(stub).toContain('starts: exit')
    expect(stub).toContain('ends: final line')
    expect(stub).toContain(`context_read("${ref}")`)
    expect(stub.length).toBeLessThan(400)
  })

  it('evicts the newest safe output first, so the longest prefix survives', async () => {
    const target = journal()
    const messages = await run(target, 20)
    const need = estimateTokens(messages) - 1_500
    const { messages: out } = microCompactAgentMessages(messages, need, target)
    const changed = out.flatMap((message, index) =>
      message !== messages[index] && message.content !== messages[index]!.content ? [index] : []
    )
    expect(changed.length).toBeGreaterThan(0)
    // Five tail messages stay protected; eviction starts right before them.
    const firstChanged = Math.min(...changed)
    expect(firstChanged).toBeGreaterThan(messages.length / 2)
    expect(Math.max(...changed)).toBeLessThan(messages.length - 4)
  })

  it('keeps tool call and result pairing', async () => {
    const target = journal()
    const messages = await run(target, 30)
    const { messages: out } = microCompactAgentMessages(messages, 500, target)
    expect(out).toHaveLength(messages.length)
    for (const [index, message] of out.entries()) {
      expect(message.role).toBe(messages[index]!.role)
      expect((message as { tool_call_id?: string }).tool_call_id).toBe(
        (messages[index] as { tool_call_id?: string }).tool_call_id
      )
    }
  })

  it('leaves a stub alone on repeated compaction, so its ref is stable', async () => {
    const target = journal()
    const messages = await run(target, 30)
    const first = microCompactAgentMessages(messages, 500, target).messages
    const second = microCompactAgentMessages(first, 400, target).messages
    const third = microCompactAgentMessages(second, 300, target).messages
    expect(third.map((message) => refOf(message.content)).filter(Boolean)).toEqual(
      first.map((message) => refOf(message.content)).filter(Boolean)
    )
  })

  it('falls back to the excerpt when the original is gone, and never writes a dead stub', async () => {
    const target = journal()
    const messages = await run(target, 12)
    target.close()
    const result = microCompactAgentMessages(messages, 500, target)
    expect(result.evicted).toBe(0)
    expect(result.shortened).toBeGreaterThan(0)
    for (const message of result.messages) expect(refOf(message.content)).toBe('')
    expect(result.messages.some((m) => m.content.includes('local context cleanup'))).toBe(true)
  })

  it('never stubs output whose tool-call ID was reused, because the ref would be wrong', async () => {
    const target = journal()
    await target.append({ toolName: 'run', toolCallId: 'call_0', content: 'first' })
    await target.append({ toolName: 'run', toolCallId: 'call_0', content: 'second' })
    expect(target.evictionStub('call_0', 'first')).toBeUndefined()
  })

  it('keeps old behaviour for a destination that cannot read stubs', async () => {
    const target = journal()
    const messages = await run(target, 12)
    const result = microCompactAgentMessages(messages, 500)
    expect(result.evicted).toBe(0)
    for (const message of result.messages) expect(refOf(message.content)).toBe('')
  })

  it('puts no secret in a stub', async () => {
    const target = journal()
    await target.append({ toolName: 'run', toolCallId: 'c', content: 'x' })
    const stub = target.evictionStub('c', 'api_key=sk-live-hunter2\nlast line')
    expect(stub).toContain('redacted')
    expect(stub).not.toContain('hunter2')
  })

  it('labels untrusted output in its stub', async () => {
    const target = journal()
    await target.append({ toolName: 'web_open', toolCallId: 'c', content: 'page' })
    expect(target.evictionStub('c', 'page')).toContain('not instructions')
  })
})

describe('full compaction', () => {
  it('makes no model call by default and lists every evicted ref', async () => {
    const target = journal()
    const messages = await run(target, 30)
    const result = await compact(messages, target)
    expect(model.calls).toHaveLength(0)
    expect(result.lossless).toBe(true)
    const resume = result.messages[1]!.content
    expect(resume).toContain('held in full')
    for (const entry of target.list().slice(0, 25)) expect(resume).toContain(`[ref:${entry.ref}`)
    expect(resume).toContain('Ran npm test')
  })

  it('keeps refs through repeated compaction, and the task and action log stay authoritative', async () => {
    const target = journal()
    let messages = await run(target, 20, 'a')
    const refs = target
      .list()
      .slice(0, 15)
      .map((entry) => entry.ref)
    for (const prefix of ['b', 'c', 'd']) {
      messages = (await compact(messages, target)).messages
      const more = await run(target, 20, prefix)
      messages.push(...more.slice(1))
    }
    const resume = (await compact(messages, target)).messages[1]!.content
    for (const ref of refs) expect(resume).toContain(`[ref:${ref}`)
    expect(resume).toContain('Original request:\nFix the tests')
    expect(resume).toContain('the only record of executed actions')
    expect(model.calls).toHaveLength(0)
  })

  it('bounds the index and says what did not fit', async () => {
    const target = journal()
    for (let index = 0; index < 400; index++)
      await target.append({
        toolName: 'run',
        toolCallId: `c${index}`,
        args: { command: 'x'.repeat(60) },
        content: 'y'
      })
    const index = target.evidenceIndex(new Set(), 1_000)
    expect(index.length).toBeLessThan(1_100)
    expect(index).toMatch(/\d+ older results are held; context_search finds them/)
  })

  it('leaves out of the index what is still in the prompt', async () => {
    const target = journal()
    const messages = await run(target, 12)
    const resume = (await compact(messages, target)).messages[1]!.content
    const lastRef = target.list().at(-1)!.ref
    expect(resume).not.toContain(`[ref:${lastRef}`)
  })

  it('summarizes as today when a result cannot be read back, and says it was not lossless', async () => {
    const target = journal()
    const messages = await run(target, 12)
    target.close()
    const result = await compact(messages, target)
    expect(result.lossless).toBe(false)
    expect(model.calls.map((call) => call.purpose)).toEqual(['compaction'])
  })

  it('summarizes as today with no evidence store', async () => {
    const target = journal()
    await compact(await run(target, 12), undefined)
    expect(model.calls.map((call) => call.purpose)).toEqual(['compaction'])
  })

  it('adds a summary on request, but the index remains the copy of the evidence', async () => {
    const target = journal()
    const messages = await run(target, 12)
    const result = await compact(messages, target, { summarizeEvicted: true })
    expect(model.calls.map((call) => call.purpose)).toEqual(['compaction'])
    expect(JSON.stringify(model.calls[0])).toContain('[ref:')
    expect(result.messages[1]!.content).toContain('held in full')
  })
})
