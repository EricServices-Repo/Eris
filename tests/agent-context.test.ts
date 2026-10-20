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

  it('keeps role instructions in the system message instead of repeating the prior answer as user intent', () => {
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
    const messages = buildPreservedWorkerMessages({
      workspacePath: folder,
      settings: getDefaults(),
      plan,
      originalUserGoal: 'Add those improvements',
      retrievalHint: 'Inspect booking.php',
      mcpToolCount: 0,
      messages: [
        { role: 'assistant', content: 'Add booking confirmation in booking.php' },
        { role: 'user', content: 'Add those improvements' }
      ]
    })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Add those improvements' })
    expect(
      messages.filter((message) => message.content === 'Add booking confirmation in booking.php')
    ).toHaveLength(1)
    expect(messages[0]?.content).toContain('EDIT PLAYBOOK')
    expect(messages[0]?.content).toContain('Inspect booking.php')
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
