import { resolveTaskDecision } from '../electron/main/services/task-resolver'
import { LocalModelWorkerError } from '../electron/main/services/llama-worker-channel'
import { modelInputBudget } from '../src/shared/model-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const h = vi.hoisted(() => ({
  budget: 16 * 1024 ** 3,
  localRefs: ['local:worker'],
  winner: null as string | null,
  released: [] as string[],
  warm: [] as string[],
  preparedWindows: [] as string[],
  warmOk: true,
  prepareHook: () => {}
}))
vi.mock('../electron/main/services/local-model', async (original) => ({
  ...(await original<object>()),
  getLocalStatuses: () => h.localRefs.map((ref) => ({
      ref,
      name: 'Worker Instruct',
      filename: `${ref.slice(6)}.gguf`,
      family: 'qwen',
      ready: true,
      approxBytes: 5 * 1024 ** 3
  })),
  findLocalEntry: (m: string) =>
    h.localRefs.includes(m)
      ? {
          id: m.slice(6),
          ref: m,
          name: 'Worker',
          displayName: 'Worker',
          description: '',
          family: 'qwen',
          quant: 'Q4_K_M',
          parameters: '7B',
          contextWindow: 32768,
          filename: 'worker.gguf',
          downloadUrl: '',
          approxBytes: 5 * 1024 ** 3,
          sha256: null,
          sizeLabel: '5 GB'
        }
      : null,
  resolveExactLocalRef: (m: string) => (h.localRefs.includes(m) ? m : null)
}))
vi.mock('../electron/main/services/builtin-model', async (original) => ({
  ...(await original<object>()),
  isExactBuiltinReady: (m: string) => m === 'builtin:composer-lite',
  resolveExactBuiltinRef: (m: string) => (m === 'builtin:composer-lite' ? m : null),
  releaseLocalChatSession: (key: string) => h.released.push(key),
  prepareNativeModelWindow: async (model: string) => { h.preparedWindows.push(model) },
  warmLocalInference: async (_: unknown, model: string) => {
    h.warm.push(model)
    h.prepareHook()
    return h.warmOk ? { ok: true, model } : { ok: false, error: 'memory unavailable' }
  }
}))
vi.mock('../electron/main/services/gpu-accel', () => ({
  getGpuAccelStatus: async () => ({ vramShareFreeBytes: h.budget }),
  lastGpuAccelStatus: () => null
}))
vi.mock('../electron/main/services/agent-telemetry', () => ({ bestModelForIntent: () => h.winner }))
vi.mock('../electron/main/services/eval-store', () => ({ bestEvalModelForIntent: () => null }))
import { getDefaults } from '../electron/main/services/settings'
import {
  planInitialChatTurn,
  resolveChatTurnContract
} from '../electron/main/services/chat-turn'
import { loadBuiltinAgents, saveProjectAgents } from '../electron/main/services/agents'
import { planChatTurn } from '../electron/main/services/chat-router'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { decideMidRunAdapt } from '../electron/main/services/agent/mid-run-adapt'
import { helperModel } from '../electron/main/services/helper-model'
import { prepareModelTransition } from '../electron/main/services/agent/model-transition'
import { recordLoadedModel, clearLoadedModel } from '../electron/main/services/model-runtime'
import {
  runInDiagnosticsScope,
  markSimulatedSettings,
  type ModelTransportRequest
} from '../electron/main/services/model-transport'
import type { TurnPlan } from '../src/shared/settings-schema'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eris-model-switch-'))
  h.localRefs = ['local:worker']
  h.budget = 16 * 1024 ** 3
  h.winner = null
  h.released = []
  h.warm = []
  h.warmOk = true
  h.prepareHook = () => {}
  clearLoadedModel()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  clearLoadedModel()
})
const settings = () => {
  const s = structuredClone(getDefaults())
  s.agent.routing.profile = 'local'
  s.agent.routing.routerModel = 'builtin:composer-lite'
  s.agent.routing.useLlmRouter = true
  return s
}
const basePlan = (): TurnPlan => ({
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'edit',
  requiresTools: true,
  reason: 'test',
  method: 'heuristic',
  modelExecution: { policy: 'auto-local', selection: 'auto-local', basis: 'test', candidates: [] }
})
async function scripted(
  goal: string,
  reply: (r: ModelTransportRequest) => string,
  supplied?: TurnPlan
) {
  const requests: ModelTransportRequest[] = [],
    events: Array<Record<string, unknown>> = []
  let plan: TurnPlan | undefined
  const s = markSimulatedSettings(settings())
  await runInDiagnosticsScope(
    {
      runId: 'model-switch',
      mode: 'simulated',
      adapter: {
        kind: 'scripted',
        async *stream(request) {
          requests.push(request)
          yield reply(request)
        }
      },
      onBlockedEffect: () => {},
      verify: () => ({ ok: true, skipped: true, command: '', detail: 'scripted' })
    },
    async () => {
      plan =
        supplied ||
        (await planChatTurn({
          workspacePath: root,
          settings: s,
          getSecret: () => null,
          context: { text: goal, selectedModel: 'auto-local', mode: 'agent' }
        }))
      for await (const event of runAgentWithWorkspaceTools({
        workspacePath: root,
        settings: s,
        model: plan.models.tools,
        turnPlan: plan,
        messages: [{ role: 'user', content: goal }],
        temperature: 0,
        getSecret: () => null,
        jobId: 'chat:model-switch',
        mcp: 'off'
      }))
        events.push(event as unknown as Record<string, unknown>)
    }
  )
  return { requests, events, plan: plan! }
}
describe('coordinator to worker at the actual transport boundary', () => {
  it('uses an available local model for routing and a tool-free story', async () => {
    const result = await scripted('Write a story about a dog named Hans', (r) =>
      r.purpose === 'route'
        ? '{"intent":"answer","agentId":"fast","confidence":0.99}'
        : 'Hans was a small dog with an enormous map. Every morning he followed its winding paths until one led him home to a friend who had been waiting all along.'
    )
    expect(result.requests.find((r) => r.purpose === 'route')?.model).toBe('local:worker')
    expect(result.requests.find((r) => r.purpose === 'agent')?.model).toBe('local:worker')
    expect(result.plan.toolPolicy).toBe('none')
    expect(result.plan.models.coordinator).toBe('local:worker')
    expect(h.warm).toEqual([]) // scripted diagnostics never allocate real models
  })
  it('defers worker ranking until intake and keeps the final model local', async () => {
    h.preparedWindows.length = 0
    const s = settings()
    s.models.connections.push({
      id: 'remote', name: 'Remote', type: 'openai-compatible', provider: 'openai',
      enabled: true, apiKeyRef: '', baseUrl: 'https://example.invalid/v1', models: ['gpt-5']
    })
    const input = { requestId: 'deferred-edit', workspacePath: root, settings: s,
      text: 'Implement these improvements in index.ts', model: 'auto-local', mode: 'agent' as const,
      getSecret: () => null, history: [
        { role: 'assistant' as const, content: '1. Add validation in index.ts.' }
      ] }
    const initial = await planInitialChatTurn(input)
    expect(initial.error).toBeUndefined()
    expect(initial.models.chat).toBe('')
    expect(initial.modelExecution?.candidates).toEqual([])
    expect(h.preparedWindows).toEqual([])
    const result = await resolveChatTurnContract(input, initial)
    expect(result.task.intent).toBe('edit')
    expect(result.plan.models.tools).toBe('local:worker')
    expect(result.plan.modelExecution?.candidates.find(item => item.model === 'gpt-5')?.eligible).toBe(false)
    expect(h.preparedWindows).toEqual(['local:worker'])
    expect(h.warm).toEqual([])
  })

  it('does not prepare a model or grant edit authority for an explicit explanation', async () => {
    const input = { requestId: 'explanation', workspacePath: root, settings: settings(),
      text: 'Explain how to implement authentication', model: 'auto-local', mode: 'agent' as const,
      getSecret: () => null, history: [] }
    const initial = await planInitialChatTurn(input)
    expect(initial.intent).toBe('answer')
    expect(initial.models.chat).toBe('')
    expect(initial.modelExecution?.candidates).toEqual([])
    expect(h.warm).toEqual([])
    const result = await resolveChatTurnContract(input, initial)
    expect(result.task.authority.edit).toBe(false)
    expect(result.task.deliverable).toBe('answer')
    expect(h.warm).toEqual([])
  })
  it('compiles the chosen page into the final, resolved task', async () => {
    writeFileSync(join(root, 'index.html'), '<main>Home</main>')
    writeFileSync(join(root, 'about.html'), '<main>About</main>')
    const askTarget = vi.fn(async () => 'about.html')
    const input = { requestId: 'choose-page', workspacePath: root, settings: settings(),
      text: 'Add a footer', model: 'auto-local', mode: 'agent' as const, askTarget,
      getSecret: () => null }
    const initial = await planInitialChatTurn(input)
    expect(initial.models.tools).toBe('')
    const { plan, task, resolution } = await resolveChatTurnContract(input, initial)
    expect(askTarget).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('footer'), ['about.html', 'index.html'])
    expect(task.requested).toMatchObject({ targetFiles: ['about.html'], state: 'resolved' })
    expect(task.authority.edit).toBe(true)
    expect(task.interpretation?.resolution).toEqual(resolution)
    expect(resolution.rule).toBe('html-target-intake')
    expect(plan.task).toBe(task)
  })

  it.each([
    ['What is a reasonable way to organize a small application?', false],
    ['Give me an idea for organizing a small application.', true]
  ] as const)('uses at most one same-model intake call for %s', async (text, classify) => {
    const s = markSimulatedSettings(settings())
    const requests: ModelTransportRequest[] = []
    const output: Array<Record<string, unknown>> = []
    await runInDiagnosticsScope(
      {
        runId: 'main-chat-handoff',
        mode: 'simulated',
        onBlockedEffect: () => {},
        adapter: {
          kind: 'scripted',
          async *stream(request) {
            requests.push(request)
            yield request.purpose === 'intent'
              ? '{"intent":"answer","confidence":0.99}'
              : 'Group related application features into small modules with explicit interfaces. Keep storage and networking behind adapters, and test behavior at those boundaries.'
          }
        }
      },
      async () => {
        const input = {
          requestId: 'main-chat-handoff',
          workspacePath: root,
          settings: s,
          text,
          model: 'local:worker',
          mode: 'agent' as const,
          getSecret: () => null,
          history: []
        }
        const initial = await planInitialChatTurn(input)
        const { plan } = await resolveChatTurnContract(input, initial)
        expect(plan.models.coordinator).toBe(classify ? 'local:worker' : undefined)
        for await (const event of runAgentWithWorkspaceTools({
          workspacePath: root,
          settings: s,
          turnPlan: plan,
          model: plan.models.chat,
          messages: [{ role: 'user', content: text }],
          temperature: 0,
          getSecret: () => null,
          jobId: 'chat:main-handoff',
          mcp: 'off'
        }))
          output.push(event as unknown as Record<string, unknown>)
      }
    )
    expect(requests.filter((r) => r.purpose === 'intent').map((r) => r.model)).toEqual(
      classify ? ['local:worker'] : []
    )
    expect(requests.some((r) => r.purpose === 'route')).toBe(false)
    expect(requests.find((r) => r.purpose === 'agent')?.model).toBe('local:worker')
    expect(output.some((event) => event.type === 'adapt')).toBe(false)
  })

  it('falls back within the routing deadline even when the provider ignores abort', async () => {
    const resolution = await runInDiagnosticsScope(
      {
        runId: 'unresponsive-classifier',
        mode: 'simulated',
        onBlockedEffect: () => {},
        adapter: {
          kind: 'scripted',
          async *stream() {
            yield await new Promise<string>(() => {})
          }
        }
      },
      () =>
        resolveTaskDecision({
          text: 'Could we make this easier to use?',
          fallback: 'edit',
          settings: markSimulatedSettings(settings()),
          model: 'local:worker',
          mode: 'agent',
          getSecret: () => null,
          timeoutMs: 20
        })
    )
    expect(resolution).toMatchObject({ intent: 'plan', source: 'fallback', failure: 'timeout' })
  })

  it('recovers a native execution failure using another eligible worker', async () => {
    let calls = 0
    const result = await scripted(
      'Create hello.txt containing hello',
      (r) => {
        if (r.model === 'builtin:composer-lite')
          throw Object.assign(new Error('VRAM allocation failed'), {
            name: 'LocalModelWorkerError'
          })
        if (!calls++)
          return '{"name":"write_file","arguments":{"path":"hello.txt","content":"hello"}}'
        return 'DONE: Created hello.txt containing hello.'
      },
      basePlan()
    )
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello')
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'adapt', model: 'local:worker' })
    )
  })

  it('recovers from generation silence after a write without writing the same bytes again', async () => {
    const write = '{"name":"write_file","arguments":{"path":"hello.txt","content":"hello"}}'
    let originalCalls = 0
    let recoveryCalls = 0
    const result = await scripted(
      'Create hello.txt containing hello',
      (request) => {
        if (request.model === 'builtin:composer-lite') {
          if (originalCalls++ === 0) return write
          throw new LocalModelWorkerError('stopped producing output during generation')
        }
        if (recoveryCalls++ === 0) return write
        return 'DONE: Created hello.txt containing hello.'
      },
      basePlan()
    )
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello')
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'adapt', model: 'local:worker' })
    )
    expect(result.events.filter((event) => event.type === 'diff')).toHaveLength(1)
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        tool: expect.objectContaining({
          name: 'write_file',
          status: 'error',
          failure: expect.objectContaining({ code: 'precondition_failed' })
        })
      })
    )
  })

  it('changes the actual worker after repeated no-progress and preserves edits', async () => {
    let writes = 0
    const result = await scripted(
      'Create hello.txt containing hello',
      (r) => {
        if (r.model === 'builtin:composer-lite')
          return 'I will inspect the project and make the requested change.'
        if (r.purpose === 'compaction') return 'Continue creating hello.txt.'
        if (!writes++)
          return '{"name":"write_file","arguments":{"path":"hello.txt","content":"hello"}}'
        return 'DONE: Created hello.txt containing hello.'
      },
      basePlan()
    )
    expect(result.requests.some((r) => r.model === 'local:worker')).toBe(true)
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello')
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'adapt', model: 'local:worker' })
    )
    const worker = result.requests.find((r) => r.model === 'local:worker')!
    expect(worker.messages.map((m) => m.content).join('\n')).toContain(
      'Create hello.txt containing hello'
    )
    expect(h.released).toContain('gguf:chat:model-switch')
  })
})
describe('provider setups at the production chat boundary', () => {
  it.each([
    { name: 'one GGUF', local: 1, remote: 0, policy: 'auto-local' },
    { name: 'two GGUFs', local: 2, remote: 0, policy: 'auto-local' },
    { name: 'one provider', local: 0, remote: 1, policy: 'auto-any' },
    { name: 'two providers', local: 0, remote: 2, policy: 'auto-any' },
    { name: 'mixed, local policy', local: 1, remote: 2, policy: 'auto-local' },
    { name: 'no model', local: 0, remote: 0, policy: 'auto-any' }
  ])('routes, delegates and bounds recovery with $name', async ({ local, remote, policy }) => {
    h.localRefs = ['local:worker', 'local:alternate'].slice(0, local)
    const remoteRefs = ['gpt-4o', 'gpt-5'].slice(0, remote)
    const s = markSimulatedSettings(settings())
    s.agent.routing.profile = 'auto'
    s.agent.helperCalls = 'off'
    s.agent.recoveryAcrossProviders = true
    s.models.connections = remoteRefs.map((model, idx) => ({
      id: `remote-${idx}`, name: model, type: 'openai-compatible', provider: 'openai',
      enabled: true, apiKeyRef: '', baseUrl: `https://fixture-${idx}.example/v1`, models: [model]
    }))
    const eligible = policy === 'auto-local' ? h.localRefs : [...h.localRefs, ...remoteRefs]
    const requests: ModelTransportRequest[] = []
    const text = 'Write a three-sentence story about a dog.'
    const input = { requestId: `provider-matrix-${local}-${remote}`, workspacePath: root,
      settings: s, text, model: policy, mode: 'agent' as const, getSecret: () => null }
    await runInDiagnosticsScope({
      runId: input.requestId, mode: 'simulated', onBlockedEffect: () => {},
      adapter: { kind: 'scripted', async *stream(request) {
        requests.push(request)
        yield 'A dog waited at the gate. His owner arrived at sunset. They walked home together.'
      } }
    }, async () => {
      const initial = await planInitialChatTurn(input)
      expect(initial.models.chat).toBe('')
      if (!eligible.length) {
        expect(initial.error).toContain('No eligible model')
        expect(requests).toHaveLength(0)
        return
      }
      const { plan, task } = await resolveChatTurnContract(input, initial)
      expect(plan.error).toBeUndefined()
      expect(eligible).toContain(plan.models.chat)
      expect(task.authority.edit).toBe(false)
      const { primary, fast } = plan.models
      if (!primary || !fast) throw new Error('Auto did not resolve both parent model classes')
      const child = await planChatTurn({ ...input, context: {
        text: 'Review the file a.ts', mode: 'agent', selectedModel: policy, skipModelRouter: true,
        inheritedModels: { primary, fast }
      } })
      expect(child.error).toBeUndefined()
      expect([primary, fast]).toContain(child.models.tools)
      const recovery = await decideMidRunAdapt({
        ...input, plan, selectedModel: plan.models.tools, startingModel: plan.models.tools,
        goal: text, rerouteCount: 0, actionLog: [], filesTouched: []
      })
      const alternatives = eligible.filter((model) => model !== plan.models.tools)
      if (alternatives.length) expect(alternatives).toContain(recovery.nextPlan?.models.tools)
      else expect(recovery.nextPlan).toBeUndefined()
      const answers: string[] = []
      for await (const event of runAgentWithWorkspaceTools({
        ...input, model: plan.models.chat, turnPlan: plan, mcp: 'off', temperature: 0,
        messages: [{ role: 'user', content: text }]
      })) if (event.type === 'answer') answers.push(event.text)
      expect(requests.filter((request) => request.purpose === 'agent').map((request) => request.model))
        .toEqual([plan.models.chat])
      expect(answers.join(' ')).toContain('walked home together')
    })
  })
})

describe('policy precedence through production planning', () => {
  it('retains an explicit agent pin but blocks its remote destination under Auto-local', async () => {
    const agents = loadBuiltinAgents()
    agents.orchestrator.model = 'remote-pinned'
    saveProjectAgents(root, agents)
    const plan = await planChatTurn({
      workspacePath: root,
      settings: settings(),
      getSecret: () => null,
      context: {
        text: 'Create hello.txt',
        selectedModel: 'auto-local',
        mode: 'agent',
        manualAgentId: agents.orchestrator.id
      }
    })
    expect(plan.models.tools).toBe('remote-pinned')
    expect(plan.error).toContain('conflicts with Auto-local')
    expect(plan.modelExecution?.policy).toBe('fixed')
  })
  it('does not select cloud-only Composer for an Ask or workspace-free request', async () => {
    for (const [mode, workspacePath] of [
      ['ask', root],
      ['agent', null]
    ] as const) {
      const s = settings()
      s.agent.routing.profile = 'auto'
      const plan = await planChatTurn({
        workspacePath,
        settings: s,
        getSecret: () => null,
        context: { text: 'Verify the code', selectedModel: 'auto-any', mode, skipModelRouter: true }
      })
      expect(plan.models.tools).not.toBe('builtin:composer')
    }
  })
})

describe('recovery preserves completed operations', () => {
  it('keeps the prior tool transcript and does not replay a completed write', async () => {
    let liteCalls = 0,
      workerCalls = 0
    const result = await scripted(
      'Create first.txt and second.txt each containing hello',
      (r) => {
        if (r.purpose === 'compaction')
          return 'first.txt already exists; second.txt is still required.'
        if (r.model === 'builtin:composer-lite') {
          if (!liteCalls++)
            return '{"name":"write_file","arguments":{"path":"first.txt","content":"hello"}}'
          return 'I will continue with the next concrete action.'
        }
        if (!workerCalls++)
          return '{"name":"write_file","arguments":{"path":"second.txt","content":"hello"}}'
        return 'DONE: Created first.txt and second.txt containing hello.'
      },
      basePlan()
    )
    expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(root, 'second.txt'), 'utf8')).toBe('hello')
    const worker = result.requests.find((r) => r.model === 'local:worker')!
    expect(JSON.stringify(worker.messages)).toContain('first.txt')
    expect(worker.messages.some((m) => m.role === 'tool')).toBe(true)
    const writes = result.events.filter((e) => e.type === 'diff')
    expect(
      writes.filter((e) => String((e.diff as { path: string }).path).endsWith('first.txt'))
    ).toHaveLength(1)
  })
})

describe('bounded recovery admission', () => {
  const decide = (plan = basePlan(), extra: Partial<Parameters<typeof decideMidRunAdapt>[0]> = {}) =>
    decideMidRunAdapt({
      workspacePath: root,
      settings: settings(),
      plan,
      selectedModel: plan.models.tools,
      goal: 'Create hello.txt',
      getSecret: () => null,
      rerouteCount: 0,
      actionLog: [],
      filesTouched: [],
      ...extra
    })
  it('selects a distinct untried local model and never cycles', async () => {
    expect((await decide()).nextPlan?.models.tools).toBe('local:worker')
    expect((await decide(basePlan(), { attemptedModels: ['local:worker'] })).kind).toBeNull()
    expect((await decide(basePlan(), { rerouteCount: 2 })).kind).toBeNull()
  })
  it('recovers within a remote provider, honors fallback order and requires cross-provider consent', async () => {
    const s = settings()
    s.agent.routing.profile = 'auto'
    s.models.connections = [
      { id: 'first', name: 'First', provider: 'custom', type: 'openai-compatible', enabled: true,
        baseUrl: 'https://first.example/v1', apiKeyRef: '', models: ['initial', 'same-a', 'same-b'] },
      { id: 'second', name: 'Second', provider: 'custom', type: 'openai-compatible', enabled: true,
        baseUrl: 'https://second.example/v1', apiKeyRef: '', models: ['cross'] }
    ]
    s.models.fallbacks = ['cross', 'same-b', 'same-a']
    h.budget = 0
    const plan = basePlan()
    plan.modelExecution!.policy = 'auto-any'
    const args = { settings: s, selectedModel: 'initial', startingModel: 'initial' }
    const same = await decide(plan, args)
    expect(same.nextPlan?.models.tools).toBe('same-b')
    expect(same.reason).toContain('configured fallback')
    expect((await decide(plan, { ...args, attemptedModels: ['same-a', 'same-b'] })).kind).toBeNull()
    s.agent.recoveryAcrossProviders = true
    expect((await decide(plan, args)).nextPlan?.models.tools).toBe('cross')
    expect((await decide(plan, { ...args, startingModel: 'local:worker' })).kind).toBeNull()
    expect((await decide(plan, { ...args, attemptedModels: ['local:worker'] })).kind).toBeNull()
    s.agent.routing.workspaceLocalOnly = true
    expect((await decide(plan, args)).kind).toBeNull()
  })

  it('preserves fixed choices, safety refusals and permission denials', async () => {
    const fixed = basePlan()
    fixed.modelExecution!.policy = 'fixed'
    expect((await decide(fixed)).nextPlan?.models.tools).not.toBe('local:worker')
    for (const failureText of [
      'I cannot assist with this request because it is unsafe.',
      'permission_denied: user denied'
    ])
      expect((await decide(basePlan(), { failureText })).nextPlan?.models.tools).not.toBe(
        'local:worker'
      )
  })
  it('revalidates capacity and fails before release when admission changes', async () => {
    h.budget = 0
    await expect(
      prepareModelTransition({
        settings: settings(),
        plan: basePlan(),
        from: 'builtin:composer-lite',
        to: 'local:worker',
        releaseSession: () => h.released.push('old'),
        getSecret: () => null
      })
    ).rejects.toThrow('no longer eligible')
    expect(h.released).toEqual([])
  })
  it('releases KV and recomputes the prompt budget after switching from 32K to 8K', async () => {
    recordLoadedModel({ ref: 'builtin:composer-lite', contextSize: 32768 })
    h.prepareHook = () => {
      expect(h.released).toEqual(['old'])
      recordLoadedModel({ ref: 'local:worker', contextSize: 8192 })
    }
    const budget = await prepareModelTransition({
      settings: settings(),
      plan: basePlan(),
      from: 'builtin:composer-lite',
      to: 'local:worker',
      releaseSession: () => h.released.push('old'),
      getSecret: () => null
    })
    expect(budget).toBe(modelInputBudget(8192, Math.floor(8192 * 0.3)))
    expect(h.warm).toEqual(['local:worker'])
  })
  it('refuses a simulated transition if its scripted transport scope is lost', async () => {
    await expect(
      prepareModelTransition({
        settings: markSimulatedSettings(settings()),
        plan: basePlan(),
        from: 'builtin:composer-lite',
        to: 'local:worker',
        releaseSession: () => {},
        getSecret: () => null
      })
    ).rejects.toThrow('without its scripted adapter')
    expect(h.warm).toEqual([])
  })
  it('fails cleanly on preparation failure and cancellation during preparation', async () => {
    h.warmOk = false
    const opts = {
      settings: settings(),
      plan: basePlan(),
      from: 'builtin:composer-lite',
      to: 'local:worker',
      releaseSession: () => {},
      getSecret: () => null
    }
    await expect(prepareModelTransition(opts)).rejects.toThrow('memory unavailable')
    h.warmOk = true
    const controller = new AbortController()
    h.prepareHook = () => controller.abort()
    await expect(
      prepareModelTransition({ ...opts, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('optional helper model selection', () => {
  it('uses Fast for helpers, keeps Primary for outcome checks on a review, and honors off', () => {
    const s = settings()
    s.agent.routing.profile = 'auto'
    const plan = basePlan()
    plan.modelExecution!.policy = 'auto-any'
    plan.models = { chat: 'primary', tools: 'primary', primary: 'primary', fast: 'fast' }
    expect(helperModel(s, plan, 'resolve')).toBe('fast')
    expect(helperModel(s, plan, 'outcome')).toBe('fast')
    expect(helperModel(s, { ...plan, intent: 'verify' }, 'outcome')).toBe('primary')
    s.agent.helperCalls = 'off'
    for (const purpose of ['route', 'resolve', 'outcome', 'compact'] as const)
      expect(helperModel(s, plan, purpose)).toBeUndefined()
  })

  it('reuses a resident native worker and skips cold native helper calls', () => {
    const s = settings()
    const plan = basePlan()
    plan.models = { chat: 'local:primary', tools: 'local:primary', fast: 'local:fast' }
    expect(helperModel(s, plan, 'resolve')).toBeUndefined()
    recordLoadedModel({ ref: 'local:primary', contextSize: 4096 })
    expect(helperModel(s, plan, 'resolve')).toBe('local:primary')
  })
})
