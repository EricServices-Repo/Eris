import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

/** #593: background children store a resolved model, never `auto`. */
const h = vi.hoisted(() => ({ root: '' }))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => ({
    mode: 'agent',
    agentId: 'reviewer',
    agentName: 'Reviewer',
    intent: 'review',
    reason: 'test',
    toolPolicy: 'read',
    models: { chat: 'local:t', tools: 'local:t' }
  })
}))
vi.mock('../electron/main/services/worktrees', () => ({
  addAgentWorktree: vi.fn(async () => ({ path: h.root, branch: 'b', destinationBranch: 'main', baseSha: 'a' })),
  diffWorktree: vi.fn(),
  mergeAgentBranch: vi.fn(),
  removeAgentWorktree: vi.fn()
}))
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: async function* () {
    yield { type: 'answer', text: 'ok' }
  }
}))

import { delegateFromAgent } from '../electron/main/services/background-agents'
import { saveProjectAgents, seedProjectAgents } from '../electron/main/services/agents'
import { userSettingsPath } from '../electron/main/services/paths'
import { invalidateResolvedSettingsCache } from '../electron/main/services/settings'
import { parseHandoff } from '../src/shared/agent-orchestration'

h.root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-bg-child-')))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

mkdirSync(dirname(userSettingsPath()), { recursive: true })
writeFileSync(
  userSettingsPath(),
  JSON.stringify({
    models: {
      connections: [
        { id: 'api', name: 'API', enabled: true, type: 'openai-compatible', provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKeyRef: '', models: ['frontier'] }
      ]
    }
  })
)
invalidateResolvedSettingsCache()

const delegate = (agentId: string, extra: Partial<Parameters<typeof delegateFromAgent>[0]> = {}) => {
  const handoff = parseHandoff({ goal: 'Check the validator', summary: 'Looked', fromAgentId: 'composer', toAgentId: agentId })
  if (!handoff.ok) throw new Error(handoff.error)
  return delegateFromAgent({
    workspacePath: h.root,
    model: 'auto',
    agentId,
    goal: 'Check the validator',
    summary: 'Looked',
    handoff: handoff.packet,
    ...extra
  })
}

describe('background child models', () => {
  it('stores the parent model the child role class names', () => {
    const models = { primary: 'local:coder-7b', fast: 'local:coder-1.5b' }
    expect(delegate('reviewer', { models }).model).toBe('local:coder-7b')
    expect(delegate('explainer', { models }).model).toBe('local:coder-1.5b')
  })
  it('refuses a remote pin under the parent turn’s local-only policy', () => {
    const roster = seedProjectAgents(h.root)
    saveProjectAgents(h.root, {
      ...roster,
      subagents: roster.subagents.map((a) => (a.id === 'reviewer' ? { ...a, model: 'frontier' } : a))
    })
    expect(() => delegate('reviewer', { models: { primary: 'local:coder-7b' }, policy: 'auto-local' })).toThrow(/does not allow/)
    expect(delegate('reviewer', { models: { primary: 'local:coder-7b' }, policy: 'auto-any' }).model).toBe('frontier')
  })
})
