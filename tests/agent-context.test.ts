import { createTaskContract } from '../electron/main/services/task-intake'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { workerConversation } from '../electron/main/services/agent/conversation'
import { summarizeAgentResults } from '../src/shared/agent-orchestration'

vi.mock('../electron/main/services/background-agents', () => ({
  listBackgroundJobs: () => [
    {
      id: 'wrong',
      sourceThreadId: 'calculator',
      goal: 'Improve calculator',
      answer: 'Edit calculator.ts',
      status: 'done'
    },
    {
      id: 'right',
      sourceThreadId: 'rentals',
      goal: 'Improve rental booking',
      answer: 'Inspect booking.php',
      status: 'done'
    }
  ]
}))
import { buildChatMessages, compactHistory } from '../electron/main/services/chat-prompt'
import { buildPreservedWorkerMessages } from '../electron/main/services/agent/prompts'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'

const folders: string[] = []
afterEach(() =>
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }))
)

describe('agent context boundaries', () => {
  it('retains repeated earlier requests, removes only the current duplicate and strips legacy worker leakage', () => {
    expect(
      workerConversation(
        [
          { role: 'user', content: 'Fix that' },
          { role: 'assistant', content: 'Inspect booking.php\n[Eris worker] Do not edit files.' },
          { role: 'user', content: 'Fix that' }
        ],
        'Fix that'
      )
    ).toEqual([
      { role: 'user', content: 'Fix that' },
      { role: 'assistant', content: 'Inspect booking.php' }
    ])
  })

  it('does not evict the request when the preceding assistant answer is oversized', () => {
    const history = compactHistory(
      [
        { role: 'user', content: 'Review the rental application in airbnb/' },
        {
          role: 'assistant',
          content: 'Recommendations for airbnb/\n' + 'x'.repeat(20000) + '\nFix booking.php'
        }
      ],
      6000
    )
    expect(history.recent[0]?.content).toContain('airbnb/')
    expect(history.recent[1]?.content).toContain('Fix booking.php')
    expect(
      history.recent.reduce((sum, message) => sum + message.content.length, 0)
    ).toBeLessThanOrEqual(6000)
  })

  it('uses only this thread’s background context and leaves the latest user request clean', () => {
    const messages = buildChatMessages(null, getDefaults(), {
      text: 'Improve',
      mode: 'agent',
      agentId: 'composer',
      threadId: 'rentals',
      history: [],
      attachments: [],
      skillIds: []
    })
    expect(JSON.stringify(messages)).toContain('booking.php')
    expect(JSON.stringify(messages)).not.toContain('calculator.ts')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Improve' })
  })

  it('keeps role instructions in the system message instead of repeating the prior answer as user intent', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'eris-context-'))
    folders.push(folder)
    const plan: TurnPlan = {
      agentId: 'composer',
      agentName: 'Composer',
      intent: 'edit',
      mode: 'agent',
      toolPolicy: 'full',
      requiresTools: true,
      escalateToFull: false,
      models: { chat: 'local:test', tools: 'local:test' },
      reason: 'Apply recommendations',
      method: 'override'
    }
    const task = createTaskContract({
      workspacePath: folder,
      text: 'Add those improvements',
      plan
    })
    const messages = await buildPreservedWorkerMessages({
      workspacePath: folder,
      settings: getDefaults(),
      plan: { ...plan, task },
      originalUserGoal: 'Add those improvements',
      retrievalHint: 'Inspect booking.php',
      mcpToolCount: 0,
      messages: [
        { role: 'assistant', content: 'Add booking confirmation in booking.php' },
        { role: 'user', content: 'Add those improvements' }
      ]
    })
    expect(messages.at(-1)?.role).toBe('user')
    expect(messages.at(-1)?.content).toMatch(/CURRENT USER REQUEST\nAdd those improvements$/)
    expect(messages.at(-1)?.content).toContain('TASK CONTRACT\n')
    expect(
      messages.filter((message) => message.content === 'Add booking confirmation in booking.php')
    ).toHaveLength(1)
    expect(messages[0]?.content).toContain('EDIT PLAYBOOK')
    expect(messages.at(-1)?.content).toContain('Inspect booking.php')
    expect(messages[0]?.content).not.toContain('Inspect booking.php')
    expect(messages[0]?.content).not.toContain('GREENFIELD BUILD')
  })

  it('propagates failed and missing specialist outcomes with evidence longer than 800 characters', () => {
    const failed = {
      id: 'child',
      agentId: 'reviewer',
      status: 'failed',
      answer: 'x'.repeat(1200) + 'root cause',
      error: 'timeout'
    }
    const result = summarizeAgentResults([failed, undefined])
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('root cause')
    expect(result.detail).toContain('timeout')
    expect(result.detail).toContain('Missing specialist')
    expect(summarizeAgentResults([{ ...failed, status: 'done', error: undefined }]).ok).toBe(true)
  })
})

describe('RAM-CTX-032 admitted recent units', () => {
  it('covers complete canonical turns, but not shortened turns or summary-only sources', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      content: i === 8 ? 'x'.repeat(2000) : 'same wording'
    }))
    const compacted = compactHistory(history, 600)
    // The tail follows the budget: short turns fit past the six-message minimum.
    expect(compacted.coveredSourceIds).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '9'])
    expect(compacted.recent.map((m) => m.id)).toEqual(history.map((m) => m.id))
    expect(compactHistory(history, 120).coveredSourceIds).not.toContain('0')
  })
})

describe('memory at model boundaries', () => {
  it('compiles recalled evidence for local models, omits it for remote workers and honors explicit opt-in', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'eris-private-context-'))
    folders.push(folder)
    const plan: TurnPlan = {
      agentId: 'composer',
      agentName: 'Composer',
      intent: 'answer',
      mode: 'ask',
      toolPolicy: 'none',
      requiresTools: false,
      escalateToFull: false,
      models: { chat: 'local:test', tools: 'local:test' },
      reason: 'test',
      method: 'manual'
    }
    const task = createTaskContract({ workspacePath: folder, text: 'Explain context', plan })
    const { prompt: memory } = {
      prompt: {
        text: 'CONVERSATION MEMORY: confidential recalled choice CAD',
        allowRemote: false,
        manifest: {
          version: 1 as const,
          revision: 1,
          generation: 1,
          totalMessages: 1000,
          retainedMessages: 1000,
          firstOrdinal: 0,
          logicalBytes: 100000,
          coverage: 'complete' as const,
          selectedIds: [],
          sourceIds: [],
          estimatedTokens: 30,
          omittedFacts: 0
        }
      }
    }
    const base = {
      workspacePath: folder,
      settings: getDefaults(),
      originalUserGoal: 'Explain context',
      retrievalHint: '',
      mcpToolCount: 0,
      messages: [{ role: 'user' as const, content: 'Explain context' }],
      conversationMemory: memory
    }
    const local = await buildPreservedWorkerMessages({ ...base, plan: { ...plan, task } })
    expect(local.at(-1)?.content).toContain('confidential recalled choice CAD')
    expect(local[0]?.content).not.toContain('confidential recalled choice CAD')
    expect(local[0]?.content).toContain('host tool gateway enforces the real task')
    const remote = {
      ...plan,
      models: { chat: 'connection:remote', tools: 'connection:remote' },
      task
    }
    expect(
      JSON.stringify(await buildPreservedWorkerMessages({ ...base, plan: remote }))
    ).not.toContain('confidential recalled choice CAD')
    expect(
      (
        await buildPreservedWorkerMessages({
          ...base,
          plan: remote,
          conversationMemory: { ...memory, allowRemote: true }
        })
      ).at(-1)?.content
    ).toContain('confidential recalled choice CAD')
    expect(local.at(-1)?.content).toMatch(/CURRENT USER REQUEST\nExplain context$/)
  })
})
