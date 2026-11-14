import { recordNativeLatency } from '../electron/main/services/model-latency'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  locals: [] as Array<Record<string, unknown>>,
  ready: new Set(['builtin:composer-lite']),
  budget: 16 * 1024 ** 3,
  winner: null as string | null,
  scored: [] as string[],
  resident: null as { ref: string; contextSize: number } | null,
  secrets: new Map<string, string>()
}))
vi.mock('../electron/main/services/credentials', () => ({
  getSecret: (key: string) => state.secrets.get(key) ?? null
}))
vi.mock('../electron/main/services/local-model', () => ({
  getLocalStatuses: () => state.locals,
  isLocalRef: (m: string) => m.startsWith('local:')
}))
vi.mock('../electron/main/services/builtin-model', () => ({
  isExactBuiltinReady: (m: string) => state.ready.has(m),
  isBuiltinRef: (m: string) => m.startsWith('builtin:'),
  isNativeGgufRef: (m: string) => /^(local:|builtin:)/.test(m),
  resolveReadyBuiltinRef: (m: string) => m
}))
vi.mock('../electron/main/services/gpu-accel', () => ({
  getGpuAccelStatus: async () => ({ vramShareFreeBytes: state.budget })
}))
vi.mock('../electron/main/services/model-runtime', () => ({
  currentLoadedModel: () => state.resident
}))
vi.mock('../electron/main/services/agent-telemetry', () => ({
  bestModelForIntent: (_: string, refs: string[]) => {
    state.scored = refs
    return state.winner
  }
}))
vi.mock('../electron/main/services/eval-store', () => ({ bestEvalModelForIntent: () => null }))
import { chooseExecutionModel, executionPolicy } from '../electron/main/services/auto-model-policy'
import { getDefaults } from '../electron/main/services/settings'
const local = (ref = 'local:qwen-coder', bytes = 5 * 1024 ** 3) => ({
  ref,
  name: ref,
  filename: 'model.gguf',
  family: 'qwen',
  ready: true,
  approxBytes: bytes
})
const settings = () => {
  const s = structuredClone(getDefaults())
  s.agent.routing.profile = 'local'
  s.agent.routing.preferCloudComposer = false
  s.models.connections = [
    {
      id: 'server',
      name: 'Server',
      enabled: true,
      type: 'openai-compatible',
      provider: 'custom',
      baseUrl: 'https://remote.example/v1',
      apiKeyRef: '',
      models: ['remote-coder']
    }
  ]
  return s
}
beforeEach(() => {
  state.locals = [local()]
  state.budget = 16 * 1024 ** 3
  state.winner = null
  state.scored = []
  state.resident = null
  state.secrets.clear()
})
describe('production Auto model selection', () => {
  it.each(['answer', 'edit', 'review', 'plan', 'verify'] as const)(
    'considers installed workers for %s before Lite',
    async (intent) => {
      const choice = await chooseExecutionModel(settings(), intent)
      expect(choice.model).toBe('local:qwen-coder')
      expect(choice.candidates.find((c) => c.model === 'local:qwen-coder')?.eligible).toBe(true)
    }
  )
  it('uses comparable local latency only for a short answer without quality evidence', async () => {
    const s = settings()
    s.models.contextWindow = 16384
    state.resident = { ref: 'builtin:composer-lite', contextSize: 16384 }
    for (const latency of [180, 200, 220]) {
      recordNativeLatency(s, 'builtin:composer-lite', 'warm-answer', latency)
      recordNativeLatency(s, 'local:qwen-coder', 'warm-answer', latency * 2)
      recordNativeLatency(s, 'local:qwen-coder', 'load', 5000)
    }
    expect((await chooseExecutionModel(s, 'answer')).model).toBe('builtin:composer-lite')
    expect((await chooseExecutionModel(s, 'edit')).model).toBe('local:qwen-coder')
    s.evals.useScoresForRouting = true
    state.winner = 'local:qwen-coder'
    expect((await chooseExecutionModel(s, 'answer')).model).toBe('local:qwen-coder')
  })

  it('filters remote scoring candidates before ranking, including approved LAN hosts', async () => {
    const s = settings()
    s.evals.useScoresForRouting = true
    state.winner = 'remote-coder'
    s.models.connections[0].recallApprovedUrl = s.models.connections[0].baseUrl
    expect((await chooseExecutionModel(s, 'edit')).model).toBe('local:qwen-coder')
    expect(state.scored).not.toContain('remote-coder')
  })
  it('allows loopback, but recomputes when its endpoint becomes remote', async () => {
    const s = settings()
    s.models.connections[0].baseUrl = 'http://127.0.0.1:11434/v1'
    expect(
      (await chooseExecutionModel(s, 'edit')).candidates.find((c) => c.model === 'remote-coder')
        ?.eligible
    ).toBe(true)
    s.models.connections[0].baseUrl = 'https://remote.example/v1'
    expect(
      (await chooseExecutionModel(s, 'edit')).candidates.find((c) => c.model === 'remote-coder')
        ?.eligible
    ).toBe(false)
  })
  it('never overrides fixed Lite or an explicitly pinned remote model', async () => {
    for (const model of ['builtin:composer-lite', 'remote-coder']) {
      expect(await chooseExecutionModel(settings(), 'edit', model)).toMatchObject({
        model,
        policy: 'fixed'
      })
    }
  })
  it('uses intent specialization rather than largest weight file', async () => {
    state.locals = [local('local:general-instruct', 10 * 1024 ** 3), local()]
    expect((await chooseExecutionModel(settings(), 'edit')).model).toBe('local:qwen-coder')
    expect((await chooseExecutionModel(settings(), 'answer')).model).toBe('local:general-instruct')
  })
  it('limits reloads across a nine-turn mix with stable eligible models', async () => {
    state.locals = [local('local:general-instruct'), local('local:qwen-coder'), local('local:other-instruct')]
    state.resident = { ref: 'local:general-instruct', contextSize: 4096 }
    const selected: string[] = []
    for (const intent of ['answer', 'answer', 'explore', 'edit', 'edit', 'review', 'answer', 'verify', 'edit'] as const) {
      const choice = await chooseExecutionModel(settings(), intent)
      selected.push(choice.model)
      expect(choice.candidates.find((candidate) => candidate.model === choice.model)?.reason).toMatch(/selected by/)
      state.resident = { ref: choice.model, contextSize: 4096 }
    }
    expect(new Set(selected).size).toBeLessThanOrEqual(2)
  })
  it('keeps an eligible resident when a heuristic competitor is only slightly higher', async () => {
    state.locals = [local('local:general-instruct'), local('local:qwen-coder')]
    state.resident = { ref: 'local:qwen-coder', contextSize: 4096 }
    const choice = await chooseExecutionModel(settings(), 'answer')
    expect(choice.model).toBe('local:qwen-coder')
    expect(choice.candidates.find((candidate) => candidate.model === choice.model)?.reason).toContain('resident within switch margin')
  })
  it('never retains a resident that declares tools unsupported for an edit', async () => {
    state.locals = [{ ...local('local:general-instruct'), routingCapabilities: { tools: false } }, local('local:qwen-coder')]
    state.resident = { ref: 'local:general-instruct', contextSize: 4096 }
    const choice = await chooseExecutionModel(settings(), 'edit')
    expect(choice.model).toBe('local:qwen-coder')
    expect(choice.candidates.find((candidate) => candidate.model === 'local:general-instruct')?.eligible).toBe(false)
  })
  it('lets measured outcomes beat resident stickiness', async () => {
    const s = settings(); s.evals.useScoresForRouting = true
    state.locals = [local('local:general-instruct'), local('local:qwen-coder')]
    state.resident = { ref: 'local:qwen-coder', contextSize: 4096 }
    state.winner = 'local:general-instruct'
    expect((await chooseExecutionModel(s, 'answer')).model).toBe('local:general-instruct')
  })
  it('rejects unknown capacity, oversized and non-chat models with reasons', async () => {
    state.budget = 0
    state.locals = [local(), local('local:embed', 1)]
    const choice = await chooseExecutionModel(settings(), 'edit')
    expect(choice.model).toBe('builtin:composer-lite')
    expect(choice.candidates.find((c) => c.model === 'local:qwen-coder')?.reason).toContain(
      'memory'
    )
    expect(choice.candidates.find((c) => c.model === 'local:embed')?.reason).toBe('non-chat model')
  })
  it('admits measured resident capacity without requiring another copy of the weights', async () => {
    state.budget = 0
    state.resident = { ref: 'local:qwen-coder', contextSize: 4096 }
    expect((await chooseExecutionModel(settings(), 'edit')).model).toBe('local:qwen-coder')
  })
  it('uses measured outcomes only inside the eligible pool', async () => {
    const s = settings()
    s.evals.useScoresForRouting = true
    state.winner = 'builtin:composer-lite'
    expect(await chooseExecutionModel(s, 'edit')).toMatchObject({
      model: state.winner,
      basis: 'telemetry'
    })
  })
  it('records which model was selected and why each other eligible model lost', async () => {
    const choice = await chooseExecutionModel(settings(), 'edit')
    const reason = (m: string) => choice.candidates.find((c) => c.model === m)?.reason
    expect(choice).toMatchObject({ model: 'local:qwen-coder', basis: 'profile' })
    expect(reason('local:qwen-coder')).toMatch(
      /^selected by heuristic task rank; heuristic task rank 28/
    )
    expect(reason('builtin:composer-lite')).toMatch(
      /^eligible, not selected: local:qwen-coder won on heuristic task rank \(28 vs 10\)/
    )
    // Ineligible models keep their exclusion reason.
    expect(reason('remote-coder')).toBe('excluded by Auto-local execution policy')
  })
  it('says a measured choice was measured, not ranked', async () => {
    const s = settings()
    s.evals.useScoresForRouting = true
    state.winner = 'builtin:composer-lite'
    const choice = await chooseExecutionModel(s, 'edit')
    const reason = (m: string) => choice.candidates.find((c) => c.model === m)?.reason
    expect(choice).toMatchObject({ model: 'builtin:composer-lite', basis: 'telemetry' })
    expect(reason('builtin:composer-lite')).toMatch(/^selected by measured run outcomes for edit/)
    expect(reason('local:qwen-coder')).toBe(
      'eligible, not selected: builtin:composer-lite won on measured run outcomes for edit; switch/load cost estimated; capability specialization inferred unless declared'
    )
  })
  it('names a tie-break by name instead of claiming a higher rank', async () => {
    state.locals = [local('local:b-coder'), local('local:a-coder')]
    const choice = await chooseExecutionModel(settings(), 'edit')
    expect(choice.model).toBe('local:a-coder')
    expect(choice.candidates.find((c) => c.model === 'local:b-coder')?.reason).toContain(
      '(tied at 28; broken by name)'
    )
  })
  it('honors explicit policy independently of the legacy profile', () => {
    expect(executionPolicy(settings(), 'auto-any')).toBe('auto-any')
    expect(executionPolicy(settings(), 'auto-local')).toBe('auto-local')
    expect(executionPolicy(settings(), 'auto')).toBe('auto-local')
  })
  it('excludes previously attempted workers for bounded recovery', async () => {
    expect(
      (await chooseExecutionModel(settings(), 'edit', 'auto-local', ['local:qwen-coder'])).model
    ).toBe('builtin:composer-lite')
  })

  describe('connection readiness (#305 MO-03)', () => {
    const keyed = (apiKeyRef: string, baseUrl = 'https://remote.example/v1') => {
      const s = settings()
      s.agent.routing.profile = 'auto'
      s.agent.routing.preferCloudComposer = true
      s.models.connections[0] = { ...s.models.connections[0]!, apiKeyRef, baseUrl }
      return s
    }
    beforeEach(() => {
      state.locals = []
    })
    it('does not prefer a keyed connection whose key is not stored over a ready Lite', async () => {
      const choice = await chooseExecutionModel(keyed('openai-key'), 'edit', 'auto-any')
      expect(choice.model).toBe('builtin:composer-lite')
      expect(choice.candidates.find((c) => c.model === 'remote-coder')).toMatchObject({
        eligible: false,
        reason: 'connection API key is not stored'
      })
    })
    it('treats a blank stored key as missing', async () => {
      state.secrets.set('openai-key', '   ')
      const choice = await chooseExecutionModel(keyed('openai-key'), 'edit', 'auto-any')
      expect(choice.model).toBe('builtin:composer-lite')
    })
    it('selects the same connection once its key is stored', async () => {
      state.secrets.set('openai-key', 'sk-test')
      const choice = await chooseExecutionModel(keyed('openai-key'), 'edit', 'auto-any')
      expect(choice.model).toBe('remote-coder')
    })
    it('keyless endpoints (no key reference) stay eligible', async () => {
      const choice = await chooseExecutionModel(keyed(''), 'edit', 'auto-any')
      expect(choice.model).toBe('remote-coder')
    })
    it('excludes a connection without a base URL', async () => {
      const choice = await chooseExecutionModel(keyed('', ''), 'edit', 'auto-any')
      expect(choice.candidates.find((c) => c.model === 'remote-coder')).toMatchObject({
        eligible: false,
        reason: 'connection has no base URL'
      })
    })
    it('recovery never reaches an unauthenticated connection', async () => {
      const choice = await chooseExecutionModel(keyed('openai-key'), 'edit', 'auto-any', [
        'builtin:composer-lite'
      ])
      expect(choice.model).toBe('')
    })
  })
})
