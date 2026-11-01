import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const h = vi.hoisted(() => ({
  budget: 16 * 1024 ** 3,
  winner: null as string | null,
  released: [] as string[],
  warm: [] as string[],
  warmOk: true,
  prepareHook: () => {}
}))
vi.mock('../electron/main/services/local-model', async (original) => ({
  ...(await original<object>()),
  getLocalStatuses: () => [
    {
      ref: 'local:worker',
      name: 'Worker Instruct',
      filename: 'worker.gguf',
      family: 'qwen',
      ready: true,
      approxBytes: 5 * 1024 ** 3
    }
  ],
  findLocalEntry: (m: string) =>
    m === 'local:worker'
      ? {
          id: 'worker',
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
  resolveExactLocalRef: (m: string) => (m === 'local:worker' ? m : null)
}))
vi.mock('../electron/main/services/builtin-model', async (original) => ({
  ...(await original<object>()),
  isExactBuiltinReady: (m: string) => m === 'builtin:composer-lite',
  resolveExactBuiltinRef: (m: string) => (m === 'builtin:composer-lite' ? m : null),
  releaseLocalChatSession: (key: string) => h.released.push(key),
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
  localChatTurnModel,
  planInitialChatTurn,
  resolveChatTurnContract
} from '../electron/main/services/chat-turn'
import { loadBuiltinAgents, saveProjectAgents } from '../electron/main/services/agents'
import { planChatTurn } from '../electron/main/services/chat-router'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { decideMidRunAdapt } from '../electron/main/services/agent/mid-run-adapt'
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
  s.agent.routing.preferCloudComposer = false
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
  escalateToFull: false,
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
  it('uses Lite for a route hint and another local worker for a tool-free story', async () => {
    const result = await scripted('Write a story about a dog named Hans', (r) =>
      r.purpose === 'route'
        ? '{"intent":"answer","agentId":"fast","confidence":0.99}'
        : 'Hans was a small dog with an enormous map. Every morning he followed its winding paths until one led him home to a friend who had been waiting all along.'
    )
    expect(result.requests.find((r) => r.purpose === 'route')?.model).toBe('builtin:composer-lite')
    expect(result.requests.find((r) => r.purpose === 'agent')?.model).toBe('local:worker')
    expect(result.plan.toolPolicy).toBe('none')
    expect(result.plan.models.coordinator).toBe('builtin:composer-lite')
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'adapt', kind: 'delegate', model: 'local:worker' })
    )
    expect(h.warm).toEqual([]) // scripted diagnostics never allocate real models
  })
  it('uses Lite intake and a local worker in the main chat-turn pipeline', async () => {
    const s = markSimulatedSettings(settings())
    const requests: ModelTransportRequest[] = []
    const output: Array<Record<string, unknown>> = []
    const text = 'What is a reasonable way to organize a small application?'
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
          model: 'auto-local',
          mode: 'agent' as const,
          getSecret: () => null,
          history: []
        }
        const initial = await planInitialChatTurn(input)
        const { plan } = await resolveChatTurnContract(input, initial)
        expect(plan.models.coordinator).toBe('builtin:composer-lite')
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
    expect(requests.find((r) => r.purpose === 'intent')?.model).toBe('builtin:composer-lite')
    expect(requests.find((r) => r.purpose === 'agent')?.model).toBe('local:worker')
    expect(output).toContainEqual(expect.objectContaining({ type: 'adapt', model: 'local:worker' }))
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
  it('does not silently convert fixed Full to Lite when local Full is unavailable', () => {
    const plan = basePlan()
    plan.modelExecution!.policy = 'fixed'
    plan.models = { chat: 'builtin:composer', tools: 'builtin:composer' }
    const local = localChatTurnModel(plan, 'builtin:composer', settings())
    expect(local.model).toBe('builtin:composer')
    expect(local.plan.error).toContain('Fixed Composer Full is unavailable')
  })
  it('does not select cloud-only Composer for an Ask or workspace-free request', async () => {
    for (const [mode, workspacePath] of [
      ['ask', root],
      ['agent', null]
    ] as const) {
      const s = settings()
      s.agent.routing.preferCloudComposer = true
      s.agent.routing.profile = 'auto'
      const plan = await planChatTurn({
        workspacePath,
        settings: s,
        getSecret: () => null,
        context: { text: 'Verify the code', selectedModel: 'auto-any', mode, skipModelRouter: true }
      })
      expect(plan.models.tools).not.toBe('builtin:composer')
      expect(plan.cloudPreferred).toBe(false)
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
  const decide = (plan = basePlan(), extra = {}) =>
    decideMidRunAdapt({
      workspacePath: root,
      settings: settings(),
      plan,
      selectedModel: plan.models.tools,
      goal: 'Create hello.txt',
      getSecret: () => null,
      escalateCount: 0,
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
  it('releases KV then uses measured target capacity after resource preparation', async () => {
    h.prepareHook = () => {
      expect(h.released).toEqual(['old'])
      recordLoadedModel({ ref: 'local:worker', contextSize: 4096 })
    }
    const budget = await prepareModelTransition({
      settings: settings(),
      plan: basePlan(),
      from: 'builtin:composer-lite',
      to: 'local:worker',
      releaseSession: () => h.released.push('old'),
      getSecret: () => null
    })
    expect(budget).toBe(Math.floor(4096 * 0.65))
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
