import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A model that answers in prose when the task still needs tools gets a nudge. The nudge
 * must use the backend's own call grammar: telling a native-tools model to "emit tool
 * JSON" makes it print the call as text, which the system prompt forbids (#506).
 */
const state = vi.hoisted(() => ({ requests: [] as Array<Array<{ role: string; content: string }>> }))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: { messages: Array<{ role: string; content: string }> }) {
    state.requests.push(JSON.parse(JSON.stringify(options.messages)))
    yield 'I would add the function to the file.'
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
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'eris-nudge-')))
  writeFileSync(join(ws, 'math.ts'), 'export const add = (a: number, b: number) => a + b\n')
  state.requests.length = 0
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

async function nudges(model: string) {
  const settings = getDefaults()
  settings.models.connections.push({
    id: 'remote', name: 'Remote', type: 'openai-compatible', provider: 'openai', enabled: true,
    baseUrl: 'https://api.example.com/v1', apiKeyRef: '', models: ['remote-model']
  } as never)
  const text = 'Add a subtract function to math.ts'
  const turnPlan: TurnPlan = {
    intent: 'edit', agentId: 'composer', agentName: 'Composer', mode: 'agent',
    models: { chat: model, tools: model }, toolPolicy: 'edit', requiresTools: true,
    escalateToFull: false, reason: 'test', method: 'manual'
  }
  turnPlan.task = createTaskContract({ workspacePath: ws, text, plan: turnPlan })
  for await (const _ of runAgentWithWorkspaceTools({
    workspacePath: ws, settings, model, messages: [{ role: 'user', content: text }],
    temperature: 0, getSecret: () => null, mode: 'agent', turnPlan, mcp: 'off'
  }))
    void _
  // Host messages added after the first request: the nudges and recovery notes.
  const first = state.requests[0]!.length
  return state.requests
    .at(-1)!
    .slice(first)
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
}

describe('nudges use the backend call grammar', () => {
  it('never shows a native-tools model a call written as text', async () => {
    const sent = await nudges('remote-model')
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.some((text) => text.includes('You must use tools to finish this request.'))).toBe(true)
    for (const text of sent) {
      expect(text).not.toMatch(/"name"\s*:|<<<TOOL>>>|tool JSON|\bDONE\b/)
    }
    expect(sent.join('\n')).toMatch(/Call the tree tool on the workspace root next\./)
  }, 60_000)

  it('gives a text-tools model the one envelope its parser accepts', async () => {
    const sent = await nudges('builtin:composer-lite')
    const first = sent.find((text) => text.includes('You must use tools to finish this request.'))!
    expect(first).toContain('<<<TOOL>>>\n{"name":"tree","arguments":{"path":"."}}\n<<<END>>>')
    for (const text of sent) expect(text).not.toMatch(/tool JSON|\bDONE\b/)
  }, 60_000)
})
