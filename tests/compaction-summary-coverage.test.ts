import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatMessage } from '../electron/main/services/agent/types'

const harness = vi.hoisted(() => ({ prompts: [] as string[], reply: '' }))
vi.mock('../electron/main/services/agent/stream', () => ({
  collectModelText: async (options: { messages: Array<{ content: string }> }) => {
    harness.prompts.push(options.messages.at(-1)!.content)
    return harness.reply
  }
}))

import {
  buildSummaryTranscript,
  compactAgentMessages
} from '../electron/main/services/agent/compaction'

const tool = (id: number, chars = 8_000): AgentChatMessage => ({
  role: 'tool',
  content: `RESULT-${id}-START ${'x'.repeat(Math.max(0, chars - 40))} RESULT-${id}-END`
})
/** Calls and results alternate in a real run; compaction keeps each pair together. */
const run = (count: number, chars?: number): AgentChatMessage[] =>
  Array.from({ length: count }, (_, i) => [
    { role: 'assistant' as const, content: `calling tool ${i + 1}` },
    tool(i + 1, chars)
  ]).flat()
const compact = (messages: AgentChatMessage[]) =>
  compactAgentMessages({
    messages,
    goal: 'finish the task',
    filesTouched: [],
    actionLog: [],
    treeSnapshot: null,
    priorMemory: null,
    settings: {} as never,
    liteModel: 'model',
    temperature: 0.2,
    getSecret: () => null
  })

beforeEach(() => {
  harness.prompts.length = 0
  harness.reply = 'Findings so far: the suite fails in the parser, and the fix is still pending.'
})

describe('summary transcript', () => {
  it('represents all twelve long tool results, not only the first three', () => {
    const { transcript, omittedMessages } = buildSummaryTranscript(
      Array.from({ length: 12 }, (_, i) => tool(i + 1))
    )
    for (let id = 1; id <= 12; id++) {
      expect(transcript).toContain(`RESULT-${id}-START`)
      expect(transcript).toContain(`RESULT-${id}-END`)
    }
    expect(omittedMessages).toBe(0)
    expect(transcript.length).toBeLessThanOrEqual(24_000)
  })
  it('gives newer messages more room than older ones', () => {
    const { transcript } = buildSummaryTranscript(Array.from({ length: 12 }, (_, i) => tool(i + 1)))
    const size = (id: number) => transcript.split(`RESULT-${id}-START`)[1]!.split('\n\nTOOL:')[0]!
    expect(size(12).length).toBeGreaterThan(size(1).length * 1.5)
  })
  it('leaves short messages whole and rolls the saving to others', () => {
    const { transcript, shortenedMessages } = buildSummaryTranscript([
      tool(1),
      { role: 'assistant', content: 'short note' },
      tool(2)
    ])
    expect(transcript).toContain('ASSISTANT:\nshort note')
    expect(shortenedMessages).toBe(0)
  })
  it('always keeps the newest message and counts what it drops', () => {
    const messages = Array.from({ length: 300 }, (_, i) => tool(i + 1, 1_000))
    const { transcript, omittedMessages } = buildSummaryTranscript(messages)
    expect(transcript).toContain('RESULT-300-START')
    expect(transcript).toContain('RESULT-300-END')
    expect(transcript).not.toContain('RESULT-1-START')
    expect(omittedMessages).toBe(234)
    expect(transcript.length).toBeLessThanOrEqual(24_000)
  })
  it('stays within budget and keeps every kept message at any length', () => {
    for (const count of [1, 2, 3, 12, 66, 67, 500]) {
      const messages = Array.from({ length: count }, (_, i) => tool(i + 1, 20_000))
      const { transcript, omittedMessages } = buildSummaryTranscript(messages)
      expect(transcript.length).toBeLessThanOrEqual(24_000)
      for (let id = omittedMessages + 1; id <= count; id++)
        expect(transcript).toContain(`RESULT-${id}-END`)
    }
  })
  it('ignores empty messages', () => {
    expect(buildSummaryTranscript([{ role: 'assistant', content: '  ' }]).transcript).toBe('')
  })
})

describe('compaction summaries', () => {
  it('sends the newest compacted turn to the summarizer', async () => {
    await compact([{ role: 'system', content: 'system' }, ...run(20)])
    // The newest messages stay verbatim, so result 17 is the newest one compacted.
    expect(harness.prompts[0]).toContain('RESULT-17-START')
    expect(harness.prompts[0]).toContain('RESULT-17-END')
    expect(harness.prompts[0]).not.toContain('RESULT-18-START')
  })
  it('discloses incomplete input in the brief, whatever the model wrote', async () => {
    const { memory } = await compact(run(20))
    expect(memory).toContain(harness.reply)
    expect(memory).toMatch(/Summary input was incomplete: \d+ were shortened/)
  })
  it('adds no note when the summarizer saw everything', async () => {
    const { memory } = await compact(run(10, 200))
    expect(memory).toBe(harness.reply)
  })
  it('keeps the brief within its size limit after adding the note', async () => {
    harness.reply = 'z'.repeat(9_000)
    const { memory } = await compact(run(20))
    expect(memory.length).toBeLessThanOrEqual(8_000)
    expect(memory).toContain('Summary input was incomplete')
  })
  it('still marks unverified execution claims', async () => {
    harness.reply = 'installed left-pad and everything else went according to plan today.'
    const { memory } = await compact(run(10, 200))
    expect(memory).toContain('[unverified: no matching executed action]')
  })
})
