import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugScenario, DebugScenarioInput } from '../src/shared/debug-runs'

/**
 * Diagnostics runs: simulated runs must never reach a provider, real-model runs
 * must be labeled and isolated, replay must not reuse approvals, and terminal
 * states must distinguish timeout from cancellation.
 */
const provider = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; kind: 'openai' | 'builtin' }>,
  replies: [] as string[]
}))

vi.mock('../electron/main/services/openai-compatible', () => ({
  streamOpenAICompatible: async function* (options: { model: string }) {
    provider.calls.push({ model: options.model, kind: 'openai' })
    yield provider.replies.shift() ?? ''
  }
}))
vi.mock('../electron/main/services/builtin-model', async () => {
  const actual = await vi.importActual<typeof import('../electron/main/services/builtin-model')>(
    '../electron/main/services/builtin-model'
  )
  return {
    ...actual,
    streamBuiltinChat: async function* (options: { modelRef: string }) {
      provider.calls.push({ model: options.modelRef, kind: 'builtin' })
      yield ''
    }
  }
})

const extra = vi.hoisted(() => ({ scenarios: new Map<string, unknown>() }))
vi.mock('../electron/main/services/debug-runs/scenarios', async () => {
  const actual = await vi.importActual<
    typeof import('../electron/main/services/debug-runs/scenarios')
  >('../electron/main/services/debug-runs/scenarios')
  return {
    ...actual,
    findDebugScenario: (id: string) =>
      (extra.scenarios.get(id) as DebugScenario | undefined) ?? actual.findDebugScenario(id)
  }
})

const { DebugScenarioSchema, debugRunVerdict } = await import('../src/shared/debug-runs')
const coordinator = await import('../electron/main/services/debug-runs/coordinator')
const { builtinDebugScenarios } = await import('../electron/main/services/debug-runs/scenarios')
const store = await import('../electron/main/services/debug-runs/store')
const { buildDebugRunExport, renderDebugRunMarkdown } =
  await import('../electron/main/services/debug-runs/export')
const { streamModelChat } = await import('../electron/main/services/chat-runtime')
const { getDefaults } = await import('../electron/main/services/settings')
const { appState } = await import('../electron/main/app-state')
const transport = await import('../electron/main/services/model-transport')

const deps = (settings = getDefaults()) => ({ settings, getSecret: () => null })

function addScenario(input: DebugScenarioInput): DebugScenario {
  const scenario = DebugScenarioSchema.parse(input)
  extra.scenarios.set(scenario.id, scenario)
  return scenario
}

function liveSettings() {
  const settings = structuredClone(getDefaults())
  settings.models.connections = [
    {
      id: 'test',
      name: 'Test provider',
      type: 'openai-compatible',
      provider: 'custom',
      enabled: true,
      baseUrl: 'http://127.0.0.1:9',
      apiKeyRef: '',
      models: ['test-live-model']
    }
  ]
  return settings
}

function diagnosticsTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('eris-diagnostics-'))
}

beforeEach(() => {
  provider.calls.length = 0
  provider.replies.length = 0
  extra.scenarios.clear()
})

describe('simulated diagnostics runs', () => {
  it('runs every built-in scenario through the production turn without any provider call', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'eris-user-project-'))
    writeFileSync(join(workspace, 'keep.txt'), 'user work\n')
    appState.currentWorkspace = workspace
    const before = diagnosticsTempDirs()

    const summary = await coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: builtinDebugScenarios().map((item) => item.id) },
      deps()
    )

    expect(provider.calls).toEqual([])
    expect(summary.label).toBe('SIMULATED MODEL RESPONSES')
    expect(summary.responseSource).toBe('scripted')
    expect(summary.model.provider).toBe('none (scripted)')
    expect(summary.verdict).toBe('PASS')
    expect(summary.passed).toBe(summary.planned)

    const detail = store.readDebugRun(summary.runId)!
    expect(detail.cases).toHaveLength(builtinDebugScenarios().length)
    for (const item of detail.cases) {
      expect(item.route).not.toBeNull()
      expect(item.modelCalls.every((call) => call.source === 'scripted')).toBe(true)
    }
    const edit = detail.cases.find((item) => item.scenarioId === 'edit-explicit-fix')!
    expect(edit.route?.intent).toBe('edit')
    expect(edit.contract?.deliverable).toBe('patch')
    expect(edit.changedPaths).toEqual(['src/divide.ts'])
    expect(edit.outcomeReview?.verdict).toBe('supported')
    // Timelines keep hashes and errors, never successful tool output (file contents).
    expect(JSON.stringify(edit.timeline)).not.toContain('reporting pipeline')
    expect(detail.responses.some((item) => item.kind === 'model')).toBe(true)

    // The selected project is untouched and every sandbox was removed.
    expect(readdirSync(workspace)).toEqual(['keep.txt'])
    expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('user work\n')
    expect(diagnosticsTempDirs()).toEqual(before)
  })

  it('reports a route-stage failure before any later-stage result', async () => {
    addScenario({
      id: 'test-route-mismatch',
      title: 'Route mismatch',
      request: { text: 'Fix the bug in src/divide.ts so dividing by zero returns 0.' },
      fixture: { 'src/divide.ts': 'export const safeDivide = (a: number, b: number) => a / b\n' },
      expect: { intent: ['review'], mutation: 'forbidden' },
      script: { agent: [{ text: 'DONE: fixed.' }] }
    })
    const summary = await coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: ['test-route-mismatch'] },
      deps()
    )
    const [result] = store.readDebugRun(summary.runId)!.cases
    expect(result!.route?.intent).toBe('edit')
    expect(result!.failure).toMatchObject({ stage: 'route', category: 'intent_mismatch' })
  })

  it('does not accept a done claim without a diff and names the exhausted script', async () => {
    addScenario({
      id: 'test-done-without-diff',
      title: 'Done claim only',
      request: { text: 'Fix the bug in src/divide.ts so dividing by zero returns 0.' },
      fixture: { 'src/divide.ts': 'export const safeDivide = (a: number, b: number) => a / b\n' },
      expect: { intent: ['edit'], mutation: 'required', terminal: 'complete' },
      script: { agent: [{ text: 'DONE: fixed.' }] }
    })
    const summary = await coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: ['test-done-without-diff'] },
      deps()
    )
    const [result] = store.readDebugRun(summary.runId)!.cases
    expect(summary.verdict).toBe('FAIL')
    expect(result!.status).toBe('failed')
    // The scripted model ran out because Eris correctly refused the bare DONE.
    expect(result!.failure).toMatchObject({ stage: 'model', category: 'script_exhausted' })
    expect(result!.checks.find((check) => check.name === 'mutation required')?.ok).toBe(false)
    expect(result!.changedPaths).toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('refuses a simulated request that reaches the provider boundary outside its scope', async () => {
    const settings = coordinator.diagnosticsSettings(getDefaults(), true)
    const drain = async (model: string) => {
      for await (const _chunk of streamModelChat({
        settings,
        model,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        getSecret: () => null
      })) {
        // drain
      }
    }
    await expect(drain('builtin:composer-lite')).rejects.toThrow(/refused/)
    await expect(drain(transport.SIMULATED_MODEL_REF)).rejects.toThrow(/refused/)
    // Derived settings objects keep the marker.
    expect(transport.isSimulatedSettings({ ...settings, agent: { ...settings.agent } })).toBe(true)
    expect(JSON.stringify(settings)).not.toContain('simulatedSettings')
    expect(provider.calls).toEqual([])
  })
})

describe('real-model diagnostics runs', () => {
  it('requires explicit acknowledgement before any provider call', async () => {
    await expect(
      coordinator.startDebugRun(
        { mode: 'real-model', scenarioIds: ['review-read-only'], model: 'test-live-model' },
        deps(liveSettings())
      )
    ).rejects.toThrow()
    await expect(
      coordinator.startDebugRun(
        {
          mode: 'real-model',
          scenarioIds: ['provider-error'],
          model: 'test-live-model',
          acknowledgeLiveCalls: true
        },
        deps(liveSettings())
      )
    ).rejects.toThrow(/cannot run in real-model mode/)
    expect(provider.calls).toEqual([])
  })

  it('is labeled REAL MODEL, calls the provider, and stays in a disposable fixture', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'eris-user-project-'))
    writeFileSync(join(workspace, 'keep.txt'), 'user work\n')
    appState.currentWorkspace = workspace
    provider.replies.push(
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      'Findings for src/retry.ts: retryDelay is capped at 4000 ms and MAX_RETRIES is not enforced by retryDelay.',
      JSON.stringify({ verdict: 'supported', reason: 'grounded' })
    )
    const summary = await coordinator.startDebugRun(
      {
        mode: 'real-model',
        scenarioIds: ['review-read-only'],
        model: 'test-live-model',
        acknowledgeLiveCalls: true
      },
      deps(liveSettings())
    )
    expect(summary.label).toBe('REAL MODEL')
    expect(summary.responseSource).toBe('live')
    expect(summary.model.ref).toBe('test-live-model')
    expect(provider.calls.length).toBeGreaterThan(0)
    expect(provider.calls.every((call) => call.model === 'test-live-model')).toBe(true)

    const detail = store.readDebugRun(summary.runId)!
    expect(detail.cases[0]!.modelCalls.every((call) => call.source === 'live')).toBe(true)
    expect(detail.cases[0]!.status).toBe('passed')
    // Replies are not stored unless capture was requested, so replay is unavailable.
    expect(detail.responses).toEqual([])
    await expect(coordinator.replayDebugRun({ runId: summary.runId }, deps())).rejects.toThrow(
      /no stored model replies/
    )
    expect(readdirSync(workspace)).toEqual(['keep.txt'])
  })
})

describe('replay of recorded responses', () => {
  it('reproduces a run without provider calls and never reuses an approval', async () => {
    const original = await coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: ['command-refused', 'edit-explicit-fix'] },
      deps()
    )
    // Simulate an artifact that recorded an approval: replay must ignore it.
    const casesPath = join(store.debugRunsDir(), `${original.runId}.cases.jsonl`)
    const tampered = readFileSync(casesPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const item = JSON.parse(line)
        item.timeline.push({
          seq: 999,
          atMs: 1,
          kind: 'approval',
          stage: 'tool_execution',
          summary: 'run approval allowed'
        })
        return JSON.stringify(item)
      })
    writeFileSync(casesPath, `${tampered.join('\n')}\n`)

    const replay = await coordinator.replayDebugRun({ runId: original.runId }, deps())
    expect(provider.calls).toEqual([])
    expect(replay.replayOf).toBe(original.runId)
    expect(replay.mode).toBe('simulated')
    expect(replay.responseSource).toBe('recorded')
    expect(replay.label).toContain('REPLAY OF RECORDED RESPONSES')
    expect(replay.verdict).toBe('PASS')

    const before = store.readDebugRun(original.runId)!.cases
    const after = store.readDebugRun(replay.runId)!.cases
    for (const [index, item] of after.entries()) {
      expect(item.route?.intent).toBe(before[index]!.route?.intent)
      expect(item.terminal).toBe(before[index]!.terminal)
      expect(item.changedPaths).toEqual(before[index]!.changedPaths)
      expect(item.checks.map((check) => check.ok)).toEqual(
        before[index]!.checks.map((check) => check.ok)
      )
      expect(item.modelCalls.every((call) => call.source === 'recorded')).toBe(true)
    }
    const refused = after.find((item) => item.scenarioId === 'command-refused')!
    expect(refused.blockedEffects.map((effect) => effect.kind)).toContain('command')
    expect(refused.timeline.some((event) => event.summary.includes('approval denied'))).toBe(true)
    // The original evidence is never overwritten.
    expect(store.readDebugRun(original.runId)!.summary.runId).toBe(original.runId)
  })
})

describe('terminal states', () => {
  it('reports a hung model as timed_out, distinct from cancellation', async () => {
    addScenario({
      id: 'test-hang-timeout',
      title: 'Hang',
      request: { text: 'How does retry timing work in this project?' },
      fixture: { 'src/retry.ts': 'export const MAX_RETRIES = 3\n' },
      expect: {},
      script: {
        agent: [{ hang: true }],
        intent: [{ text: '{"intent":"explore","confidence":0.9}' }]
      },
      timeoutMs: 250
    })
    const started = Date.now()
    const summary = await coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: ['test-hang-timeout'] },
      deps()
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    const [result] = store.readDebugRun(summary.runId)!.cases
    expect(result!.status).toBe('timed_out')
    expect(result!.terminal).toBe('stopped')
    expect(result!.failure).toMatchObject({ stage: 'lifecycle', category: 'timed_out' })
    expect(summary.timedOut).toBe(1)
    expect(summary.verdict).toBe('FAIL')
  })

  it('reports user cancellation as cancelled and stops remaining cases', async () => {
    addScenario({
      id: 'test-hang-cancel',
      title: 'Hang until cancelled',
      request: { text: 'How does retry timing work in this project?' },
      fixture: { 'src/retry.ts': 'export const MAX_RETRIES = 3\n' },
      expect: {},
      script: {
        agent: [{ hang: true }],
        intent: [{ text: '{"intent":"explore","confidence":0.9}' }]
      },
      timeoutMs: 60_000
    })
    const pending = coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: ['test-hang-cancel', 'edit-explicit-fix'] },
      deps()
    )
    await vi.waitFor(() => expect(coordinator.isDebugRunActive()).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(coordinator.cancelDebugRun()).toBe(true)
    const summary = await pending
    const cases = store.readDebugRun(summary.runId)!.cases
    expect(summary.status).toBe('cancelled')
    expect(summary.verdict).toBe('CANCELLED')
    expect(cases).toHaveLength(1)
    expect(cases[0]!.status).toBe('cancelled')
    expect(cases[0]!.failure?.category).toBe('user_cancelled')
    expect(coordinator.isDebugRunActive()).toBe(false)
  })

  it('derives run verdicts without treating partial runs as passing', () => {
    const base = {
      status: 'completed' as const,
      planned: 3,
      completed: 3,
      passed: 3,
      failed: 0,
      timedOut: 0,
      errored: 0
    }
    expect(debugRunVerdict(base)).toBe('PASS')
    expect(debugRunVerdict({ ...base, passed: 2, failed: 1 })).toBe('FAIL')
    expect(debugRunVerdict({ ...base, passed: 2, timedOut: 1 })).toBe('FAIL')
    expect(debugRunVerdict({ ...base, completed: 2, passed: 2 })).toBe('INCOMPLETE')
    expect(debugRunVerdict({ ...base, status: 'error', completed: 1, passed: 1 })).toBe(
      'INCOMPLETE'
    )
    expect(debugRunVerdict({ ...base, status: 'cancelled', completed: 1, passed: 1 })).toBe(
      'CANCELLED'
    )
    expect(debugRunVerdict({ ...base, status: 'running' })).toBeNull()
  })
})

describe('scenario and artifact boundaries', () => {
  it('rejects fixture paths that could escape the sandbox and host command checks', () => {
    const base = {
      id: 'x',
      title: 'x',
      request: { text: 'x' },
      expect: {}
    }
    for (const path of ['../escape.txt', '/etc/passwd', 'C:\\Windows\\x', 'a\\..\\..\\b', 'a\0b']) {
      expect(DebugScenarioSchema.safeParse({ ...base, fixture: { [path]: 'x' } }).success).toBe(
        false
      )
    }
    expect(
      DebugScenarioSchema.safeParse({
        ...base,
        expect: { checks: [{ type: 'command', command: 'rm -rf /' }] }
      }).success
    ).toBe(false)
    expect(DebugScenarioSchema.safeParse({ ...base, fixture: { 'src/a/b.ts': 'x' } }).success).toBe(
      true
    )
  })

  it('rejects run ids that are not plain identifiers', () => {
    expect(() => store.assertRunId('../../settings')).toThrow()
    expect(() => store.assertRunId('a/b')).toThrow()
    expect(store.readDebugRun('2026-10-21T00-00-00-000Z-simulated-deadbeef')).toBeNull()
  })

  it('exports redacted metadata and includes model replies only on request', async () => {
    const summary = await coordinator.startDebugRun(
      { mode: 'simulated', scenarioIds: ['edit-explicit-fix'] },
      deps()
    )
    const detail = store.readDebugRun(summary.runId)!
    detail.cases[0]!.warnings.push(`token=sk-abcdefghijklmnopqrstuv in ${homedir()}/project`)

    const plain = buildDebugRunExport(detail, false)
    expect(plain.includes.responses).toBe(false)
    expect(plain.responses).toBeUndefined()
    const text = JSON.stringify(plain)
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuv')
    expect(text).not.toContain(homedir())

    const withReplies = buildDebugRunExport(detail, true)
    expect(withReplies.responses?.some((item) => item.kind === 'model')).toBe(true)

    const markdown = renderDebugRunMarkdown(detail)
    expect(markdown.split('\n')[0]).toBe('# Eris diagnostics run — SIMULATED MODEL RESPONSES')
    expect(markdown).toContain('What this run can and cannot establish')
  })

  it('marks a run left running by an earlier session as interrupted', () => {
    const runId = '2026-10-20T00-00-00-000Z-simulated-0badc0de'
    const summary = {
      ...JSON.parse(JSON.stringify(coordinator.listDebugRuns()[0])),
      runId,
      status: 'running',
      verdict: null
    }
    store.writeRunSummary(summary)
    const listed = coordinator.listDebugRuns().find((item) => item.runId === runId)!
    expect(listed.status).toBe('error')
    expect(listed.verdict).toBe('INCOMPLETE')
    expect(store.deleteDebugRun(runId)).toBe(true)
    expect(existsSync(join(store.debugRunsDir(), `${runId}.summary.json`))).toBe(false)
  })
})
