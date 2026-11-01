import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Scripted fake-model test for the core agent loop: replays a model that emits a
 * write_file tool call and then a DONE reply, against a real temp workspace, and
 * asserts the file was written and the loop finished. Guards the loop's parse →
 * dispatch → checkpoint → summary path against regressions.
 */

// Replay queue: each entry is the full assistant text for one model turn.
const script: string[] = []
vi.mock('../electron/main/services/chat-runtime', () => ({
  // eslint-disable-next-line require-yield
  streamModelChat: async function* () {
    const next = script.shift() ?? 'DONE: nothing left to do.'
    yield next
  }
}))

// Keep the loop off the network / heavy subsystems.
vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => ({ ok: true, skipped: true, command: '', detail: '' })
}))
vi.mock('../electron/main/services/mcp-runtime', () => ({
  syncMcpRuntime: async () => undefined,
  listMcpTools: () => [],
  isMcpToolName: () => false,
  callMcpTool: async () => ({ ok: false, detail: 'no mcp' }),
  formatLiveMcpToolsPrompt: () => ''
}))
vi.mock('../electron/main/services/workspace-search', () => ({
  retrieveContextAsync: async () => ({ ok: true, paths: [], detail: '' }),
  workspaceGlob: () => ({ ok: true, detail: '' }),
  workspaceGrep: async () => ({ ok: true, detail: '' })
}))
vi.mock('../electron/main/services/code-index', () => ({
  findReferences: () => ({ ok: true, detail: '' }),
  findSymbols: () => ({ ok: true, detail: '' }),
  relatedFiles: () => ({ ok: true, detail: '' }),
  formatIndexSummary: () => ''
}))

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { getDefaults } from '../electron/main/services/settings'
import type { AgentChatMessage } from '../electron/main/services/agent/types'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eris-loop-'))
  script.length = 0
})
afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function editPlan(): TurnPlan {
  return {
    intent: 'edit',
    agentId: 'composer',
    agentName: 'Composer',
    mode: 'agent',
    models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
    toolPolicy: 'edit',
    requiresTools: true,
    escalateToFull: false,
    reason: 'test',
    method: 'manual'
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const e of gen) events.push(e as Record<string, unknown>)
  return events
}

describe('agent loop (scripted model)', () => {
  it('writes a file from a tool call, then finishes on a DONE reply', async () => {
    script.push('{"name":"write_file","path":"hello.txt","content":"hi there\\n"}')
    script.push('DONE: created hello.txt')

    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'You are Composer.' },
      { role: 'user', content: 'Create hello.txt containing a greeting.' }
    ]

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath: ws,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages,
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: editPlan(),
        mcp: 'off'
      })
    )

    expect(existsSync(join(ws, 'hello.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toContain('hi there')

    const diff = events.find((e) => e.type === 'diff')
    expect(diff).toBeTruthy()
    const answer = events.find((e) => e.type === 'answer')
    expect(answer).toBeTruthy()
  })

  it('answers directly in ask mode without touching the workspace', async () => {
    script.push('Here is an explanation, no tools needed.')
    const plan = editPlan()
    plan.mode = 'ask'
    plan.intent = 'answer'
    plan.requiresTools = false
    plan.toolPolicy = 'none'

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath: ws,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [
          { role: 'system', content: 'You are Composer.' },
          { role: 'user', content: 'Explain what a closure is.' }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'ask',
        turnPlan: plan,
        mcp: 'off'
      })
    )
    const answer = events.find((e) => e.type === 'answer')
    expect(answer).toBeTruthy()
    expect(String((answer as { text: string }).text)).toContain('explanation')
  })
})

describe('Auto story request through the actual answer-only agent loop', () => {
  it.each([true, false])(
    'handles a bare refusal with bounded recovery (recovers=%s)',
    async (recovers) => {
      const refusal = "I'm sorry, but I can't assist with that request."
      const story =
        'Hans followed a trail of blue ribbons through the village. At the last gate, his best friend was waiting with a warm blanket and a very large biscuit.'
      script.push(refusal, recovers ? story : refusal)
      const plan: TurnPlan = {
        ...editPlan(),
        agentId: 'fast',
        agentName: 'Fast',
        intent: 'answer',
        requiresTools: false,
        toolPolicy: 'none',
        method: 'heuristic'
      }
      const events = await drain(
        runAgentWithWorkspaceTools({
          workspacePath: ws,
          settings: getDefaults(),
          model: 'builtin:composer-lite',
          messages: [
            { role: 'system', content: 'You are Fast.' },
            { role: 'user', content: 'Write a story about a dog named Hans' }
          ],
          temperature: 0.3,
          getSecret: () => null,
          mode: 'agent',
          turnPlan: plan,
          mcp: 'off'
        })
      )
      expect(events.some((event) => event.type === 'tool' || event.type === 'diff')).toBe(false)
      expect(script).toHaveLength(0)
      if (recovers) {
        expect(events.filter((event) => event.type === 'answer').at(-1)?.text).toBe(story)
        expect(events.some((event) => event.type === 'progress' && event.incomplete)).toBe(false)
      } else {
        expect(events.some((event) => event.type === 'progress' && event.incomplete === true)).toBe(
          true
        )
      }
    }
  )
})
