import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  locals: [] as Array<Record<string, unknown>>, ready: new Set(['builtin:composer-lite']),
  budget: 16 * 1024 ** 3, winner: null as string | null,
  scored: [] as string[], resident: null as {ref: string; contextSize: number} | null
}))
vi.mock('../electron/main/services/local-model', () => ({ getLocalStatuses: () => state.locals, isLocalRef: (m: string) => m.startsWith('local:') }))
vi.mock('../electron/main/services/builtin-model', () => ({
  isExactBuiltinReady: (m: string) => state.ready.has(m),
  isBuiltinRef: (m: string) => m.startsWith('builtin:'),
  isNativeGgufRef: (m: string) => /^(local:|builtin:)/.test(m),
  resolveReadyBuiltinRef: (m: string) => m
}))
vi.mock('../electron/main/services/gpu-accel', () => ({
  getGpuAccelStatus: async () => ({ vramShareFreeBytes: state.budget })
}))
vi.mock('../electron/main/services/model-runtime', () => ({ currentLoadedModel: () => state.resident }))
vi.mock('../electron/main/services/agent-telemetry', () => ({
  bestModelForIntent: (_: string, refs: string[]) => { state.scored = refs; return state.winner }
}))
vi.mock('../electron/main/services/eval-store', () => ({ bestEvalModelForIntent: () => null }))
import { chooseExecutionModel, executionPolicy } from '../electron/main/services/auto-model-policy'
import { getDefaults } from '../electron/main/services/settings'
const local = (ref = 'local:qwen-coder', bytes = 5 * 1024 ** 3) => ({
  ref, name: ref, filename: 'model.gguf', family: 'qwen', ready: true, approxBytes: bytes
})
const settings = () => {
  const s = getDefaults()
  s.agent.routing.profile = 'local'
  s.agent.routing.preferCloudComposer = false
  s.models.connections = [{ id: 'server', name: 'Server', enabled: true,
    type: 'openai-compatible', provider: 'custom', baseUrl: 'https://remote.example/v1',
    apiKeyRef: '', models: ['remote-coder'] }]
  return s
}
beforeEach(() => {
  state.locals = [local()]; state.budget = 16 * 1024 ** 3
  state.winner = null; state.scored = []; state.resident = null
})
describe('production Auto model selection', () => {
  it.each(['answer', 'edit', 'review', 'plan', 'verify'] as const)('considers installed workers for %s before Lite', async (intent) => {
    const choice = await chooseExecutionModel(settings(), intent)
    expect(choice.model).toBe('local:qwen-coder')
    expect(choice.candidates.find((c) => c.model === 'local:qwen-coder')?.eligible).toBe(true)
  })
  it('filters remote scoring candidates before ranking, including approved LAN hosts', async () => {
    const s = settings(); s.evals.useScoresForRouting = true; state.winner = 'remote-coder'
    s.models.connections[0].recallApprovedUrl = s.models.connections[0].baseUrl
    expect((await chooseExecutionModel(s, 'edit')).model).toBe('local:qwen-coder')
    expect(state.scored).not.toContain('remote-coder')
  })
  it('allows loopback, but recomputes when its endpoint becomes remote', async () => {
    const s = settings(); s.models.connections[0].baseUrl = 'http://127.0.0.1:11434/v1'
    expect((await chooseExecutionModel(s, 'edit')).candidates.find((c) => c.model === 'remote-coder')?.eligible).toBe(true)
    s.models.connections[0].baseUrl = 'https://remote.example/v1'
    expect((await chooseExecutionModel(s, 'edit')).candidates.find((c) => c.model === 'remote-coder')?.eligible).toBe(false)
  })
  it('never overrides fixed Lite or an explicitly pinned remote model', async () => {
    for (const model of ['builtin:composer-lite', 'remote-coder']) {
      expect(await chooseExecutionModel(settings(), 'edit', model)).toMatchObject({ model, policy: 'fixed' })
    }
  })
  it('uses intent specialization rather than largest weight file', async () => {
    state.locals = [local('local:general-instruct', 10 * 1024 ** 3), local()]
    expect((await chooseExecutionModel(settings(), 'edit')).model).toBe('local:qwen-coder')
    expect((await chooseExecutionModel(settings(), 'answer')).model).toBe('local:general-instruct')
  })
  it('rejects unknown capacity, oversized and non-chat models with reasons', async () => {
    state.budget = 0
    state.locals = [local(), local('local:embed', 1)]
    const choice = await chooseExecutionModel(settings(), 'edit')
    expect(choice.model).toBe('builtin:composer-lite')
    expect(choice.candidates.find((c) => c.model === 'local:qwen-coder')?.reason).toContain('memory')
    expect(choice.candidates.find((c) => c.model === 'local:embed')?.reason).toBe('non-chat model')
  })
  it('admits measured resident capacity without requiring another copy of the weights', async () => {
    state.budget = 0; state.resident = { ref: 'local:qwen-coder', contextSize: 4096 }
    expect((await chooseExecutionModel(settings(), 'edit')).model).toBe('local:qwen-coder')
  })
  it('uses measured outcomes only inside the eligible pool', async () => {
    const s = settings(); s.evals.useScoresForRouting = true; state.winner = 'builtin:composer-lite'
    expect(await chooseExecutionModel(s, 'edit')).toMatchObject({ model: state.winner, basis: 'telemetry' })
  })
  it('honors explicit policy independently of the legacy profile', () => {
    expect(executionPolicy(settings(), 'auto-any')).toBe('auto-any')
    expect(executionPolicy(settings(), 'auto-local')).toBe('auto-local')
    expect(executionPolicy(settings(), 'auto')).toBe('auto-local')
  })
  it('excludes previously attempted workers for bounded recovery', async () => {
    expect((await chooseExecutionModel(settings(), 'edit', 'auto-local', ['local:qwen-coder'])).model).toBe('builtin:composer-lite')
  })
})
