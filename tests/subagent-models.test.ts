import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** #593: delegated children reuse the parent's resolved models. */
const state = vi.hoisted(() => ({ autoCalls: 0, locals: [] as Array<Record<string, unknown>> }))
vi.mock('../electron/main/services/credentials', () => ({ getSecret: () => null }))
vi.mock('../electron/main/services/local-model', () => ({
  getLocalStatuses: () => state.locals,
  isLocalRef: (m: string) => m.startsWith('local:'),
  resolveExactLocalRef: (m: string) => m
}))
vi.mock('../electron/main/services/gpu-accel', () => ({
  getGpuAccelStatus: async () => ({ vramShareFreeBytes: 32 * 1024 ** 3 })
}))
vi.mock('../electron/main/services/model-runtime', () => ({ currentLoadedModel: () => null }))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* () {
    yield ''
  }
}))
vi.mock('../electron/main/services/auto-model-policy', async (original) => {
  const actual = await original<typeof import('../electron/main/services/auto-model-policy')>()
  return {
    ...actual,
    chooseExecutionModel: async (...args: Parameters<typeof actual.chooseExecutionModel>) => {
      state.autoCalls++
      return actual.chooseExecutionModel(...args)
    }
  }
})

import { planChatTurn } from '../electron/main/services/chat-router'
import { saveProjectAgents, seedProjectAgents } from '../electron/main/services/agents'
import { getDefaults } from '../electron/main/services/settings'
import { inheritedModelForAgent } from '../src/shared/agent-model-class'

function settings() {
  const s = structuredClone(getDefaults())
  s.models.connections = [
    {
      id: 'api',
      name: 'API',
      enabled: true,
      type: 'openai-compatible',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKeyRef: '',
      models: ['frontier', 'other-remote']
    }
  ]
  return s
}
const parent = { primary: 'local:coder-7b', fast: 'local:coder-7b' }

const child = (agentId: string, policy: string, workspacePath: string | null = null, inheritedModels = parent) =>
  planChatTurn({
    workspacePath,
    settings: settings(),
    getSecret: () => null,
    context: { text: 'Review the change in src/app.ts', selectedModel: policy, mode: 'agent', skipModelRouter: true, manualAgentId: agentId, inheritedModels }
  })

function withPin(agentId: string, model: string, run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'eris-child-model-'))
  const roster = seedProjectAgents(root)
  saveProjectAgents(root, {
    ...roster,
    subagents: roster.subagents.map((a) => (a.id === agentId ? { ...a, model } : a))
  })
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

beforeEach(() => {
  state.autoCalls = 0
  state.locals = []
})

describe('child model inheritance', () => {
  it('runs a child on the parent model without a second Auto pick', async () => {
    const reviewer = await child('reviewer', 'auto-any')
    expect(reviewer.models.tools).toBe('local:coder-7b')
    expect(reviewer.models.primary).toBe('local:coder-7b')
    expect(state.autoCalls).toBe(0)
  })
  it('gives each role the parent model its class names', async () => {
    const split = { primary: 'frontier', fast: 'local:coder-1.5b' }
    expect((await child('reviewer', 'auto-any', null, split)).models.tools).toBe('frontier')
    expect((await child('explainer', 'auto-any', null, split)).models.tools).toBe('local:coder-1.5b')
  })
  it('a Composer → Reviewer → Composer sequence stays on one local model', async () => {
    const models = [await child('reviewer', 'auto-local'), await child('planner', 'auto-local'), await child('explainer', 'auto-local')]
    expect(new Set(models.map((m) => m.models.tools))).toEqual(new Set(['local:coder-7b']))
  })
  it('lets a role pin the policy allows win', async () => {
    await withPin('reviewer', 'other-remote', async (root) => {
      const reviewer = await child('reviewer', 'auto-any', root)
      expect(reviewer.models.tools).toBe('other-remote')
      expect(reviewer.error).toBeUndefined()
    })
  })
  it('refuses a pin the parent policy forbids instead of using another model', async () => {
    await withPin('reviewer', 'frontier', async (root) => {
      const reviewer = await child('reviewer', 'auto-local', root)
      expect(reviewer.error).toMatch(/does not allow\. The delegation did not run/)
    })
  })
})

describe('inheritedModelForAgent', () => {
  it('uses the pin, then the class, then the fallback', () => {
    const models = { primary: 'p', fast: 'f' }
    expect(inheritedModelForAgent({ id: 'reviewer', model: 'pinned' }, models, 'x')).toBe('pinned')
    expect(inheritedModelForAgent({ id: 'reviewer', model: 'auto' }, models, 'x')).toBe('p')
    expect(inheritedModelForAgent({ id: 'explainer', model: '' }, models, 'x')).toBe('f')
    expect(inheritedModelForAgent({ id: 'explainer' }, { primary: 'p' }, 'x')).toBe('p')
    expect(inheritedModelForAgent(null, {}, 'x')).toBe('x')
  })
})
