import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

/**
 * The whole first request for a set of standard turns, with a size budget for each
 * (#540 item 18). A prompt edit that grows a turn, repeats the role, or shows a
 * native-tools model a call written as text fails here, in review, with the numbers.
 *
 * Budgets are about 15% above the measured size; raise one only with a reason.
 */
type Wire = { role: string; content: string }
const state = vi.hoisted(() => ({ first: null as null | { messages: Wire[]; tools: unknown[] } }))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: { messages: Wire[]; tools?: unknown[] }) {
    state.first ??= { messages: JSON.parse(JSON.stringify(options.messages)), tools: options.tools ?? [] }
    yield 'The project is a small demo; see README.md.'
  }
}))
vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => ({ ok: true, skipped: true, command: '', detail: '', skipReason: 'no-project-check' })
}))
vi.mock('../electron/main/services/mcp-runtime', () => ({
  syncMcpRuntime: async () => undefined,
  listMcpTools: () => [],
  isMcpToolName: () => false,
  callMcpTool: async () => ({ ok: false, detail: 'no mcp' }),
  formatLiveMcpToolsPrompt: () => ''
}))

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { buildChatMessages } from '../electron/main/services/chat-prompt'
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'eris-budget-')))
  writeFileSync(join(ws, 'package.json'), '{"name":"demo","scripts":{"test":"vitest run"}}')
  writeFileSync(join(ws, 'README.md'), '# Demo\nA todo app.\n')
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b\n')
  state.first = null
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

async function firstRequest(text: string, over: Partial<TurnPlan>) {
  const settings = getDefaults()
  settings.models.connections.push({
    id: 'remote', name: 'Remote', type: 'openai-compatible', provider: 'openai', enabled: true,
    baseUrl: 'https://api.example.com/v1', apiKeyRef: '', models: ['remote-model']
  } as never)
  const turnPlan: TurnPlan = {
    intent: 'edit', agentId: 'composer', agentName: 'Composer', mode: 'agent',
    models: { chat: 'remote-model', tools: 'remote-model' }, toolPolicy: 'edit',
    requiresTools: true, escalateToFull: false, reason: 'test', method: 'manual', ...over
  }
  turnPlan.task = createTaskContract({ workspacePath: ws, text, plan: turnPlan })
  const messages = buildChatMessages(ws, settings, {
    text, mode: turnPlan.mode, agentId: turnPlan.agentId, history: [], attachments: [], skillIds: []
  })
  for await (const _ of runAgentWithWorkspaceTools({
    workspacePath: ws, settings, model: 'remote-model', messages, temperature: 0,
    getSecret: () => null, mode: turnPlan.mode, turnPlan, mcp: 'off'
  }))
    void _
  const { messages: wire, tools } = state.first!
  // The temp folder's path and name differ per machine; measure with a fixed stand-in.
  const stable = (text: string) => text.split(ws).join('/ws/demo').split(basename(ws)).join('demo')
  const system = stable(wire.filter((m) => m.role === 'system').map((m) => m.content).join('\n'))
  const user = stable(wire.filter((m) => m.role === 'user').map((m) => m.content).join('\n'))
  return { system, user, tools, toolChars: JSON.stringify(tools).length }
}

const TURNS = [
  ['edit', 'Add a subtract function to src/math.ts', { intent: 'edit', toolPolicy: 'edit' }, 2650, 780],
  ['explore', 'How does this project work?', { intent: 'explore', agentId: 'explainer', agentName: 'Explainer', toolPolicy: 'read' }, 2800, 570],
  ['review', 'Review src/math.ts', { intent: 'review', agentId: 'reviewer', agentName: 'Reviewer', toolPolicy: 'read' }, 2700, 580],
  ['run', 'Run npm test and tell me the result', { intent: 'run', toolPolicy: 'full' }, 2450, 790],
  ['generic answer', 'Write a python function that reverses a string', { intent: 'answer', agentId: 'explainer', agentName: 'Explainer', toolPolicy: 'none', mode: 'ask', requiresTools: false }, 1820, 1100]
] as const

describe('compiled request budgets', () => {
  it.each(TURNS)('%s turn stays within its budget and states each thing once', async (_name, text, over, systemBudget, userBudget) => {
    const { system, user, tools } = await firstRequest(text, over as Partial<TurnPlan>)
    expect(system.length, `system is ${system.length}`).toBeLessThan(systemBudget)
    // On failure the message shows the turn, so the reviewer sees what grew.
    expect(user.length, `user turn is ${user.length}:\n${user}`).toBeLessThan(userBudget)
    expect(system.split('Role: ').length - 1).toBe(1)
    expect(system.split('Shared rules (every role inherits these)').length - 1).toBe(1)
    expect(system.split('PLAYBOOK').length - 1).toBeLessThanOrEqual(1)
    // A native-tools model is never shown a tool call written as text.
    expect(system + user).not.toMatch(/<<<TOOL>>>|\{"name"\s*:/)
    // Host bookkeeping the model cannot use.
    expect(user).not.toMatch(/acceptanceCriteria|CURRENT PLAN|are claimed/)
    expect(user).toContain(text)
    if ((over as Partial<TurnPlan>).toolPolicy === 'none') expect(tools).toHaveLength(0)
    else expect(tools.length).toBeGreaterThan(3)
  }, 60_000)

  it('gives read-only turns no editing tool', async () => {
    const { tools } = await firstRequest('Review src/math.ts', { intent: 'review', agentId: 'reviewer', agentName: 'Reviewer', toolPolicy: 'read' })
    const names = (tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
    for (const name of ['write_file', 'search_replace', 'apply_patch', 'delete_path']) expect(names).not.toContain(name)
  }, 60_000)
})
