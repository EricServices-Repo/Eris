import { beforeEach, describe, expect, it, vi } from 'vitest'

/** #590: primary and fast model classes for agent roles. */
const state = vi.hoisted(() => ({
  locals: [] as Array<Record<string, unknown>>,
  resident: null as { ref: string; contextSize: number } | null
}))
vi.mock('../electron/main/services/credentials', () => ({ getSecret: () => null }))
vi.mock('../electron/main/services/local-model', () => ({
  getLocalStatuses: () => state.locals,
  isLocalRef: (m: string) => m.startsWith('local:'),
  resolveExactLocalRef: (m: string) => m
}))
vi.mock('../electron/main/services/gpu-accel', () => ({
  getGpuAccelStatus: async () => ({ vramShareFreeBytes: 32 * 1024 ** 3 })
}))
vi.mock('../electron/main/services/model-runtime', () => ({ currentLoadedModel: () => state.resident }))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* () {
    yield ''
  }
}))

import { agentModelClass, BUILTIN_MODEL_CLASS } from '../src/shared/agent-model-class'
import { chooseExecutionModel } from '../electron/main/services/auto-model-policy'
import { planChatTurn, resolveFastModel } from '../electron/main/services/chat-router'
import { getDefaults } from '../electron/main/services/settings'
import { AgentDefinitionSchema } from '../src/shared/settings-schema'
import agents from '../resources/agents.json'
import { seedProjectAgents, saveProjectAgents } from '../electron/main/services/agents'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const local = (ref: string, gb: number) => ({
  ref,
  name: ref,
  filename: `${ref}.gguf`,
  family: 'qwen',
  ready: true,
  approxBytes: gb * 1024 ** 3
})

/** A frontier API model plus one small local model. */
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
      models: ['frontier']
    }
  ]
  s.models.capabilityProfiles = {
    frontier: { tier: 'frontier', toolCalling: 'native', contextWindow: 200000, reasoning: true, vision: false, costClass: 'high' },
    'local:small-coder': { tier: 'small', toolCalling: 'text', contextWindow: 32768, reasoning: false, vision: false, costClass: 'free-local' }
  }
  return s
}

const turn = (s: ReturnType<typeof settings>, manualAgentId: string, selectedModel = 'auto-any') =>
  planChatTurn({
    workspacePath: null,
    settings: s,
    getSecret: () => null,
    context: { text: 'What does this function return?', selectedModel, mode: 'agent', skipModelRouter: true, manualAgentId }
  })

beforeEach(() => {
  state.locals = [local('local:small-coder', 2)]
  state.resident = null
})

describe('role classes', () => {
  it('fills an absent class from the built-in role table', () => {
    expect(agentModelClass({ id: 'coder' })).toBe('primary')
    expect(agentModelClass({ id: 'reviewer' })).toBe('primary')
    expect(agentModelClass({ id: 'explainer' })).toBe('fast')
    expect(agentModelClass({ id: 'fast' })).toBe('fast')
    expect(agentModelClass({ id: 'custom-role' })).toBe('primary')
    expect(agentModelClass({ id: 'coder', modelClass: 'fast' })).toBe('fast')
  })
  it('ships the class on every built-in role and parses older definitions without one', () => {
    for (const a of [agents.orchestrator, ...agents.subagents]) {
      expect(a.modelClass).toBe(BUILTIN_MODEL_CLASS[a.id])
      expect(AgentDefinitionSchema.parse(a).modelClass).toBe(a.modelClass)
    }
    const { modelClass: _omit, ...older } = agents.subagents[0]!
    expect(AgentDefinitionSchema.parse(older).modelClass).toBeUndefined()
  })
  it('defaults models.fast to Auto-fast', () => {
    expect(getDefaults().models.fast).toBe('auto')
  })
})

describe('Auto-fast', () => {
  it('prefers a cheap model at tier standard or below, and Auto keeps the strong one', async () => {
    const s = settings()
    expect((await chooseExecutionModel(s, 'answer', 'auto-any', [], { modelClass: 'fast' })).model).toBe('local:small-coder')
    expect((await chooseExecutionModel(s, 'edit', 'auto-any')).model).toBe('frontier')
  })
  it('falls back to the only model when nothing smaller exists', async () => {
    const s = settings()
    state.locals = []
    expect((await chooseExecutionModel(s, 'answer', 'auto-any', [], { modelClass: 'fast' })).model).toBe('frontier')
  })
  it('uses a Fixed fast model only when the policy allows it', async () => {
    const s = settings()
    s.models.fast = 'frontier'
    const primary = await chooseExecutionModel(s, 'answer', 'auto-local')
    expect((await resolveFastModel(s, 'answer', 'auto-local', primary)).model).toBe('local:small-coder')
    const anyPrimary = await chooseExecutionModel(s, 'answer', 'auto-any')
    expect((await resolveFastModel(s, 'answer', 'auto-any', anyPrimary)).model).toBe('frontier')
  })
  it('keeps the loaded local model rather than swapping local workers per role', async () => {
    const s = settings()
    s.models.connections = []
    state.locals = [local('local:big-coder', 9), local('local:small-coder', 2)]
    s.models.capabilityProfiles['local:big-coder'] = { tier: 'strong', toolCalling: 'native', contextWindow: 65536, reasoning: false, vision: false, costClass: 'free-local' }
    const primary = await chooseExecutionModel(s, 'edit', 'auto-local')
    expect(primary.model).toBe('local:big-coder')
    expect((await resolveFastModel(s, 'edit', 'auto-local', primary)).model).toBe('local:big-coder')
  })
})

describe('turn plans', () => {
  it('runs Coder on the primary model and Explainer on the fast one under Auto (any)', async () => {
    const s = settings()
    const coder = await turn(s, 'coder')
    expect(coder.models.chat).toBe('frontier')
    expect(coder.models).toMatchObject({ primary: 'frontier', fast: 'local:small-coder', modelClass: 'primary' })
    expect(coder.reason).toContain('primary frontier')
    const explainer = await turn(s, 'explainer')
    expect(explainer.models.chat).toBe('local:small-coder')
    expect(explainer.models.modelClass).toBe('fast')
    expect(explainer.reason).toContain('fast local:small-coder')
  })
  it('resolves both classes to local models under Auto (this computer only)', async () => {
    const coder = await turn(settings(), 'coder', 'auto-local')
    expect(coder.models.primary).toBe('local:small-coder')
    expect(coder.models.fast).toBe('local:small-coder')
  })
  it('lets a role pin win over its class', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-model-class-'))
    try {
      const roster = seedProjectAgents(root)
      saveProjectAgents(root, {
        ...roster,
        subagents: roster.subagents.map((a) => (a.id === 'explainer' ? { ...a, model: 'frontier' } : a))
      })
      const pinned = await planChatTurn({
        workspacePath: root,
        settings: settings(),
        getSecret: () => null,
        context: { text: 'What does this function return?', selectedModel: 'auto-any', mode: 'agent', skipModelRouter: true, manualAgentId: 'explainer' }
      })
      expect(pinned.models.chat).toBe('frontier')
      expect(pinned.models.modelClass).toBeUndefined()
      expect(pinned.reason).toContain('pinned frontier')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('keeps the class from a saved roster', () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-model-class-'))
    try {
      const roster = seedProjectAgents(root)
      expect(roster.subagents.find((a) => a.id === 'explainer')?.modelClass).toBe('fast')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('uses a Fixed chat selection for every role', async () => {
    const explainer = await turn(settings(), 'explainer', 'frontier')
    expect(explainer.models.chat).toBe('frontier')
    expect(explainer.models.fast).toBe('frontier')
  })
})
