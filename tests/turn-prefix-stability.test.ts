import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildPreservedWorkerMessages } from '../electron/main/services/agent/prompts'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import type { AgentChatMessage } from '../electron/main/services/agent/types'
import type { TurnPlan } from '../src/shared/settings-schema'

/**
 * #233 needs a prompt prefix that stays byte-identical from one turn to the next, or a
 * retained KV sequence has nothing to reuse. The response contract is derived from each
 * request (its artifact, stack and obligations), so it must travel with the turn.
 */
const folders: string[] = []
afterEach(() => folders.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const plan: TurnPlan = {
  agentId: 'composer',
  agentName: 'Composer',
  intent: 'edit',
  mode: 'agent',
  toolPolicy: 'full',
  requiresTools: true,
  escalateToFull: false,
  models: { chat: 'local:test', tools: 'local:test' },
  reason: 'test',
  method: 'override'
}

/** One scripted thread: same role and intent, requests that differ in stack and obligations. */
const REQUESTS = [
  'Add input validation to the booking form',
  'Rewrite the receipt export in TypeScript and keep the CSV header order',
  'Add a retry to the webhook sender, log each attempt, and do not change the public API',
  'Port the date helper to Python',
  'Fix the rounding in invoice totals and add a test for it'
]

async function turns(workspace: string) {
  const prompts: AgentChatMessage[][] = []
  const history: AgentChatMessage[] = []
  for (const [i, text] of REQUESTS.entries()) {
    const task = createTaskContract({ workspacePath: workspace, text, taskId: `t${i}`, plan })
    prompts.push(
      await buildPreservedWorkerMessages({
        workspacePath: workspace,
        settings: getDefaults(),
        plan: { ...plan, task },
        originalUserGoal: text,
        retrievalHint: '',
        mcpToolCount: 0,
        messages: [...history, { role: 'user', content: text }]
      })
    )
    history.push({ role: 'user', content: text }, { role: 'assistant', content: `Done: ${text}` })
  }
  return prompts
}

/** Characters the next prompt shares with the previous one, from the start. */
function sharedPrefix(previous: AgentChatMessage[], next: AgentChatMessage[]) {
  const a = previous.map((m) => `${m.role}\n${m.content}\n`).join('')
  const b = next.map((m) => `${m.role}\n${m.content}\n`).join('')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return { shared: i, total: b.length }
}

describe('turn-to-turn prompt prefix (#233)', () => {
  it('keeps the system prefix identical across requests with different contracts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'eris-prefix-'))
    folders.push(workspace)
    const prompts = await turns(workspace)
    const systems = new Set(prompts.map((prompt) => prompt[0]!.content))
    expect(systems.size).toBe(1)
    expect([...systems][0]).not.toContain('RESPONSE CONTRACT')
    for (const [i, prompt] of prompts.entries()) {
      const turn = prompt.at(-1)!.content
      expect(turn).toContain('RESPONSE CONTRACT — patch')
      expect(turn).toContain(`"taskId":"t${i}"`)
    }
    // A stack named only in one request reaches only that request's turn.
    expect(prompts[1]!.at(-1)!.content).toContain('TypeScript')
    expect(prompts[3]!.at(-1)!.content).toContain('Python')
    expect(prompts[3]!.at(-1)!.content).not.toContain('TypeScript')
  })

  it('reuses everything before the previous request on the next turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'eris-prefix-'))
    folders.push(workspace)
    const prompts = await turns(workspace)
    for (let i = 1; i < prompts.length; i++) {
      const previous = prompts[i - 1]!,
        next = prompts[i]!
      // The previous turn's own request is rewritten from its layered form to plain text,
      // so reuse reaches exactly the system prefix plus the history both turns share.
      const common = previous.slice(0, -1)
      expect(next.slice(0, common.length)).toEqual(common)
      const { shared } = sharedPrefix(previous, next)
      const floor = common.map((m) => `${m.role}\n${m.content}\n`).join('').length
      expect(shared).toBeGreaterThanOrEqual(floor)
    }
  })
})
