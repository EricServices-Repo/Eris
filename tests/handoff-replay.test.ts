import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A coordinator, its children and an unrelated request running through the production
 * scheduler, handoff contract, eligibility checks and transport. Only the provider adapter
 * and the tool loop are scripted. Results are read from what the adapter received.
 */
const h = vi.hoisted(() => ({
  root: '',
  sent: [] as Array<{ owner: string; model: string; content: string }>,
  owner: 'unset',
  hold: new Map<string, Promise<void>>(),
  open: [] as Array<() => void>,
  beforePrepare: async (): Promise<void> => {},
  blocked: [] as string[],
  diagnostics: false
}))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
vi.mock('../electron/main/services/ollama-runtime', async (original) => ({
  ...(await original<object>()),
  prepareModelWindows: async () => h.beforePrepare()
}))
vi.mock('../electron/main/services/openai-compatible', async (original) => ({
  ...(await original<object>()),
  streamOpenAICompatible: async function* (request: {
    model: string
    messages: Array<{ content: string }>
  }) {
    h.sent.push({
      owner: h.owner,
      model: request.model,
      content: request.messages.map((message) => message.content).join('\n')
    })
    yield 'ok'
  }
}))
vi.mock('../electron/main/services/model-transport', async (original) => ({
  ...(await original<object>()),
  activeDiagnosticsScope: () =>
    h.diagnostics
      ? { onBlockedEffect: (_kind: string, detail: string) => h.blocked.push(detail) }
      : undefined
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => ({
    mode: 'agent',
    agentId: 'reviewer',
    agentName: 'Reviewer',
    intent: 'review',
    reason: 'replay',
    toolPolicy: 'read',
    models: { chat: 'local-model', tools: 'local-model' }
  })
}))
vi.mock('../electron/main/services/worktrees', () => ({
  addAgentWorktree: vi.fn(async (_root: string, id: string) => ({
    path: h.root,
    branch: `b-${id}`,
    destinationBranch: 'main',
    baseSha: 'a'
  })),
  diffWorktree: vi.fn(),
  mergeAgentBranch: vi.fn(),
  removeAgentWorktree: vi.fn()
}))
// The tool loop is scripted. The contract it receives and the transport it uses are real.
vi.mock('../electron/main/services/agent-runner', async () => {
  const { streamModelChat } = await import('../electron/main/services/chat-runtime')
  const { compileTaskContext } = await import('../electron/main/services/agent/context-compiler')
  return {
    runAgentWithWorkspaceTools: async function* (options: {
      jobId: string
      settings: AppSettings
      messages: Array<{ role: 'system' | 'user'; content: string }>
      turnPlan: { task?: TaskContract }
    }) {
      await h.hold.get(options.jobId)
      h.owner = options.jobId
      // As in the loop: a briefing is optional project evidence, the goal is the user turn.
      const briefing = options.messages.filter((message) => message.role === 'system')
      const compiled = options.turnPlan.task
        ? [
            compileTaskContext({
              task: options.turnPlan.task,
              guidance: 'g',
              project: briefing.map((message) => message.content).join('\n'),
              retrieval: '',
              maxInputTokens: 2000
            }).message
          ]
        : briefing
      for await (const text of streamModelChat({
        settings: options.settings,
        model: 'local-model',
        messages: [
          ...compiled,
          ...options.messages.filter((message) => message.role === 'user')
        ] as never,
        temperature: 0,
        getSecret: () => null
      }))
        yield { type: 'answer', text }
    }
  }
})

import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import {
  conversationContext,
  invalidateConversationMemory,
  saveMemoryControls
} from '../electron/main/services/context-memory'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { leaseMemoryEvidence, runInEvidenceScope } from '../electron/main/services/memory-dispatch'
import {
  delegateFromAgent,
  enqueueBackgroundJob,
  getBackgroundJob,
  listBackgroundJobs,
  stopAllBackgroundJobs,
  stopBackgroundJob
} from '../electron/main/services/background-agents'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import { createTaskContract } from '../electron/main/services/task-intake'
import * as profileSettings from '../electron/main/services/settings'
import { emptyMemoryControls, type MemoryPrompt } from '../src/shared/context-memory'
import type { AppSettings } from '../src/shared/settings-schema'
import type { TaskContract } from '../src/shared/task-contract'
import {
  evaluateHandoffReplay,
  HANDOFF_REPLAY_FAMILIES,
  type HandoffReplayReport,
  type HandoffReplayRow
} from '../checks/handoff-replay'

const THREAD = 'replay'
const PARENT_ONLY = 'PARENT-ONLY-ZURICH'
const REQUIRED = 'REQUIRED-HALF-EVEN'
/** The contract field, not the word: the parent's own request text also says Python. */
const LANGUAGE = '"language":"Python"'
const MARKERS = [PARENT_ONLY, REQUIRED, LANGUAGE, 'UNRELATED-REQUEST']

h.root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-replay-')))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

let folder: string
let db: ChatDatabase
const rows: HandoffReplayRow[] = []

const settings = (parallel = 1) => {
  const value = structuredClone(profileSettings.getDefaults())
  Object.assign(value.agent.contextMemory, { foregroundDeadlineMs: 2000 })
  value.backgroundAgents.maxParallel = parallel
  const server = {
    enabled: true,
    type: 'openai-compatible' as const,
    provider: 'custom',
    apiKeyRef: ''
  }
  value.models.connections = [
    {
      ...server,
      id: 'loop',
      name: 'Loop',
      models: ['local-model'],
      baseUrl: 'http://localhost:9011/v1'
    },
    {
      ...server,
      id: 'cloud',
      name: 'Cloud',
      models: ['remote-model'],
      baseUrl: 'https://api.example.com/v1'
    }
  ] as AppSettings['models']['connections']
  return value
}
const use = (value: AppSettings) =>
  vi.spyOn(profileSettings, 'getResolvedSettings').mockReturnValue(value)

/** The parent's constraint sits far outside the recent window. */
const longThread = () => ({
  id: THREAD,
  title: 'Long replay',
  model: 'local-model',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: 'constraint',
      role: 'user' as const,
      content: `Remember: invoices must use ${PARENT_ONLY} rounding`,
      createdAt: 1
    },
    ...Array.from({ length: 80 }, (_, index) => ({
      id: `filler-${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `Discussion ${index} about the renderer layout`,
      createdAt: 1
    }))
  ]
})

const dispatched = (owner: string) => h.sent.filter((row) => row.owner === owner)
const markersIn = (owner: string) => {
  const text = dispatched(owner)
    .map((row) => row.content)
    .join('\n')
  return MARKERS.filter((marker) => text.includes(marker))
}
const record = (
  row: Omit<HandoffReplayRow, 'dispatchedMarkers' | 'modelCalls' | 'dispatchedChars'>
) => {
  const built = {
    ...row,
    dispatchedMarkers: markersIn(row.taskId),
    modelCalls: dispatched(row.taskId).length,
    dispatchedChars: dispatched(row.taskId).reduce((sum, item) => sum + item.content.length, 0)
  }
  rows.push(built)
  return built
}
const outcomeOf = (id: string): HandoffReplayRow['outcome'] => {
  const job = getBackgroundJob(id)
  if (job?.status === 'done') return 'completed'
  if (job?.status === 'stopped') return 'stopped'
  return dispatched(id).length ? 'failed' : 'blocked'
}
const finished = (id: string) =>
  vi.waitFor(() => expect(['done', 'failed', 'stopped']).toContain(getBackgroundJob(id)?.status), {
    timeout: 4000
  })

const plan = {
  mode: 'agent',
  intent: 'edit',
  toolPolicy: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  models: { chat: 'local-model', tools: 'local-model' }
} as never

/** A real recall, shown to a real dispatch, then delegation while that lease is alive. */
async function coordinator(
  owner: string,
  text: string,
  during: (input: { prompt: MemoryPrompt; task: TaskContract }) => Promise<void> | void
) {
  const scope = {}
  let release: () => void = () => undefined
  await runInEvidenceScope(async () => {
    const value = profileSettings.getResolvedSettings(null)
    const { prompt } = await conversationContext(null, THREAD, 'invoices rounding', value)
    expect(prompt.items?.map((item) => item.sourceId)).toContain('constraint')
    release = leaseMemoryEvidence({ root: null, threadId: THREAD, taskId: owner, prompt })
    h.owner = owner
    for await (const _ of streamModelChat({
      settings: value,
      model: 'local-model',
      messages: [
        { role: 'system', content: prompt.text },
        { role: 'user', content: text }
      ],
      temperature: 0,
      getSecret: () => null
    }));
    await during({
      prompt,
      task: createTaskContract({ workspacePath: h.root, text, plan })
    })
  }, scope)
  return release
}

function child(
  task: TaskContract,
  goal: string,
  extra: { constraints?: string[]; summary?: string } = {}
) {
  const summary = extra.summary ?? `The coordinator found ${PARENT_ONLY} rounding applies`
  return delegateFromAgent({
    workspacePath: h.root,
    model: 'local-model',
    agentId: 'reviewer',
    goal,
    summary,
    handoff: {
      task,
      parentGoal: task.originalText,
      goal,
      summary,
      constraints: extra.constraints ?? [],
      fromAgentId: 'composer',
      toAgentId: 'reviewer'
    }
  })
}

/** Takes the only slot, so the next job waits until the parent has gone. */
function occupySlot() {
  let open = () => {}
  const blocker = enqueueBackgroundJob(h.root, { goal: 'blocker', model: 'local-model' })
  h.hold.set(blocker.id, new Promise<void>((resolve) => (open = resolve)))
  h.open.push(() => open())
  return { blocker, open: () => open() }
}

async function queuedChild(goal: string, owner: string) {
  use(settings(1))
  const { blocker, open } = occupySlot()
  let job!: ReturnType<typeof child>
  let parent!: TaskContract
  const release = await coordinator(owner, 'Review the invoices', ({ task }) => {
    parent = task
    job = child(task, goal)
  })
  expect(getBackgroundJob(job.id)?.status).toBe('queued')
  release()
  return {
    job,
    parent,
    start: async () => {
      open()
      await finished(blocker.id)
      await finished(job.id)
    }
  }
}

beforeEach(() => {
  h.sent.length = 0
  h.owner = 'unset'
  h.hold.clear()
  h.blocked.length = 0
  h.diagnostics = false
  h.beforePrepare = async () => {}
  contextMemoryStore.clear()
  folder = mkdtempSync(join(tmpdir(), 'eris-replay-db-'))
  db = new ChatDatabase(folder)
  vi.mocked(workspaceRequest).mockImplementation(
    async (request) =>
      (await handleWorkspaceRequest({ ...request, dir: folder } as WorkspaceRequest)) as never
  )
  db.save(longThread())
})
afterEach(async () => {
  for (const open of h.open.splice(0)) open()
  await stopAllBackgroundJobs()
  vi.restoreAllMocks()
  closeChatDatabases()
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('multi-agent RAM handoff replay', () => {
  it('HR-001: an unrelated request is not rewritten by a live lease', async () => {
    use(settings(4))
    const owner = 'hr-001-parent'
    const text = `UNRELATED-REQUEST about invoices must use ${PARENT_ONLY} rounding`
    const release = await coordinator(owner, 'Review the invoices', async () => {
      await saveMemoryControls(null, THREAD, {
        ...emptyMemoryControls(),
        forgotten: ['constraint']
      })
      await runInEvidenceScope(async () => {
        h.owner = 'hr-001-unrelated'
        for await (const _ of streamModelChat({
          settings: profileSettings.getResolvedSettings(null),
          model: 'local-model',
          messages: [{ role: 'user', content: text }],
          temperature: 0,
          getSecret: () => null
        }));
      }, {})
    })
    release()
    expect(dispatched('hr-001-unrelated')[0]?.content).toBe(text)
    record({
      scenario: 'concurrent request carries its own text',
      family: 'HR-001',
      parentTaskId: null,
      taskId: 'hr-001-unrelated',
      contextOrigin: 'unrelated-request',
      selectedSourceIds: [],
      requiredMarkers: ['UNRELATED-REQUEST', PARENT_ONLY],
      forbiddenMarkers: [],
      outcome: 'completed',
      expectedOutcome: 'completed'
    })
  })

  it('HR-002: a queued child stops when its evidence was forgotten after the parent left', async () => {
    const { job, parent, start } = await queuedChild('Check the invoice totals', 'hr-002-parent')
    await saveMemoryControls(null, THREAD, { ...emptyMemoryControls(), forgotten: ['constraint'] })
    invalidateConversationMemory(null, THREAD)
    await start()
    expect(getBackgroundJob(job.id)?.error).toMatch(/changed or been removed/)
    record({
      scenario: 'source forgotten while queued',
      family: 'HR-002',
      parentTaskId: parent.taskId,
      taskId: job.id,
      contextOrigin: 'queued-handoff',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [],
      forbiddenMarkers: [PARENT_ONLY],
      outcome: outcomeOf(job.id),
      expectedOutcome: 'blocked',
      error: getBackgroundJob(job.id)?.error ?? undefined
    })
  })

  it('HR-002: a queued child still runs while its evidence stands', async () => {
    const { job, parent, start } = await queuedChild('Check the invoice totals', 'hr-002-kept')
    await start()
    record({
      scenario: 'evidence unchanged while queued',
      family: 'HR-002',
      parentTaskId: parent.taskId,
      taskId: job.id,
      contextOrigin: 'queued-handoff',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [PARENT_ONLY],
      forbiddenMarkers: [],
      outcome: outcomeOf(job.id),
      expectedOutcome: 'completed'
    })
  })

  it('HR-003: a child keeps the language its parent required', async () => {
    use(settings(2))
    let job!: ReturnType<typeof child>
    let parent!: TaskContract
    const release = await coordinator(
      'hr-003-parent',
      'Implement a booking service in Python',
      ({ task }) => {
        parent = task
        job = child(task, 'Implement the booking validator')
      }
    )
    await finished(job.id)
    release()
    record({
      scenario: 'subgoal omits the language',
      family: 'HR-003',
      parentTaskId: parent.taskId,
      taskId: job.id,
      contextOrigin: 'queued-handoff',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [LANGUAGE],
      forbiddenMarkers: [],
      outcome: outcomeOf(job.id),
      expectedOutcome: 'completed'
    })
  })

  it('HR-004: a required constraint survives a crowded briefing', async () => {
    use(settings(2))
    let job!: ReturnType<typeof child>
    let parent!: TaskContract
    const release = await coordinator('hr-004-parent', 'Review the invoices', ({ task }) => {
      parent = task
      job = child(task, 'Check the invoice totals', {
        constraints: [REQUIRED],
        summary: 'x '.repeat(7_000)
      })
    })
    await finished(job.id)
    release()
    record({
      scenario: 'constraint outside the optional briefing',
      family: 'HR-004',
      parentTaskId: parent.taskId,
      taskId: job.id,
      contextOrigin: 'queued-handoff',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [REQUIRED],
      forbiddenMarkers: [],
      outcome: outcomeOf(job.id),
      expectedOutcome: 'completed'
    })
  })

  it('HR-005: a source forgotten during model preparation never reaches the adapter', async () => {
    use(settings(2))
    const owner = 'hr-005-parent'
    const scope = {}
    let release: () => void = () => undefined
    await runInEvidenceScope(async () => {
      const value = profileSettings.getResolvedSettings(null)
      const { prompt } = await conversationContext(null, THREAD, 'invoices rounding', value)
      expect(prompt.text).toContain(PARENT_ONLY)
      release = leaseMemoryEvidence({ root: null, threadId: THREAD, taskId: owner, prompt })
      h.owner = owner
      h.beforePrepare = async () => {
        h.beforePrepare = async () => {}
        await saveMemoryControls(null, THREAD, {
          ...emptyMemoryControls(),
          forgotten: ['constraint']
        })
        invalidateConversationMemory(null, THREAD)
      }
      for await (const _ of streamModelChat({
        settings: value,
        model: 'local-model',
        messages: [
          { role: 'system', content: prompt.text },
          { role: 'user', content: 'What about the invoices?' }
        ],
        temperature: 0,
        getSecret: () => null
      }));
    }, scope)
    release()
    record({
      scenario: 'forget lands after the first eligibility check',
      family: 'HR-005',
      parentTaskId: null,
      taskId: owner,
      contextOrigin: 'parent-recall',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [],
      forbiddenMarkers: [PARENT_ONLY],
      outcome: dispatched(owner).length ? 'completed' : 'blocked',
      expectedOutcome: 'completed'
    })
  })

  it('accounts for a child stopped before it started', async () => {
    const { job, parent, start } = await queuedChild('Check the invoice totals', 'stop-parent')
    stopBackgroundJob(job.id)
    await start()
    record({
      scenario: 'stopped while queued',
      family: 'accounting',
      parentTaskId: parent.taskId,
      taskId: job.id,
      contextOrigin: 'queued-handoff',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [],
      forbiddenMarkers: [PARENT_ONLY],
      outcome: outcomeOf(job.id),
      expectedOutcome: 'stopped'
    })
  })

  it('recovers evidence from durable history after pressure evicts the store', async () => {
    const { job, parent, start } = await queuedChild('Check the invoice totals', 'pressure-parent')
    contextMemoryStore.setPressureLimit(0)
    expect(contextMemoryStore.logicalBytes).toBe(0)
    contextMemoryStore.setPressureLimit(Infinity)
    await start()
    record({
      scenario: 'store emptied while queued, then a cold reload',
      family: 'accounting',
      parentTaskId: parent.taskId,
      taskId: job.id,
      contextOrigin: 'queued-handoff',
      selectedSourceIds: ['constraint'],
      requiredMarkers: [PARENT_ONLY],
      forbiddenMarkers: [],
      outcome: outcomeOf(job.id),
      expectedOutcome: 'completed'
    })
  })

  it('refuses to create a real job from a diagnostics run', () => {
    use(settings(2))
    const before = listBackgroundJobs(h.root).length
    h.diagnostics = true
    expect(() =>
      enqueueBackgroundJob(h.root, { goal: 'diagnostic child', model: 'local-model' })
    ).toThrow(/disabled in diagnostics/)
    h.diagnostics = false
    expect(h.blocked).toHaveLength(1)
    expect(listBackgroundJobs(h.root)).toHaveLength(before)
  })
})

describe('handoff replay report', () => {
  const row: HandoffReplayRow = {
    scenario: 's',
    family: 'HR-001',
    parentTaskId: null,
    taskId: 't',
    contextOrigin: 'parent-recall',
    selectedSourceIds: [],
    dispatchedMarkers: ['FACT'],
    requiredMarkers: ['FACT'],
    forbiddenMarkers: [],
    outcome: 'completed',
    expectedOutcome: 'completed',
    modelCalls: 1,
    dispatchedChars: 10
  }
  const report = (rows: HandoffReplayRow[]): HandoffReplayReport => ({
    version: 1,
    evidence: 'deterministic-scripted',
    rows,
    resources: { reservedBytesAfter: 0, persistedDiagnosticJobs: 0 }
  })
  const complete = HANDOFF_REPLAY_FAMILIES.map((family) => ({ ...row, family }))

  it('passes only when every family was exercised', () => {
    expect(evaluateHandoffReplay(report(complete))).toEqual([])
    expect(evaluateHandoffReplay(report(complete.slice(1)))).toEqual([
      'Replay has no scenario for HR-001'
    ])
    expect(evaluateHandoffReplay(undefined)).toEqual(['Missing handoff replay report'])
  })

  it('gives no credit for a fact that never reached the provider', () => {
    const failures = evaluateHandoffReplay(
      report([{ ...complete[0]!, dispatchedMarkers: [] }, ...complete.slice(1)])
    )
    expect(failures).toEqual(['HR-001 s: FACT never reached the provider'])
  })

  it('fails on a leak, a wrong outcome, a blocked call and an unlabelled result', () => {
    const [first, ...rest] = complete
    expect(
      evaluateHandoffReplay(report([{ ...first!, forbiddenMarkers: ['FACT'] }, ...rest]))
    ).toEqual(['HR-001 s: FACT reached the provider'])
    expect(evaluateHandoffReplay(report([{ ...first!, outcome: 'failed' }, ...rest]))).toEqual([
      'HR-001 s: ended failed, expected completed'
    ])
    expect(
      evaluateHandoffReplay(
        report([{ ...first!, outcome: 'blocked', expectedOutcome: 'blocked' }, ...rest])
      )
    ).toEqual(['HR-001 s: blocked but still called a model'])
    expect(evaluateHandoffReplay({ ...report(complete), evidence: 'live' as never })).toEqual([
      'Unexpected evidence label live'
    ])
  })

  it('fails when memory or a job outlives the replay', () => {
    expect(
      evaluateHandoffReplay({
        ...report(complete),
        resources: { reservedBytesAfter: 512, persistedDiagnosticJobs: 1 }
      })
    ).toEqual(['512 bytes still reserved after the replay', 'Diagnostics created 1 real jobs'])
  })

  it('gates and exports the rows this run captured', () => {
    const captured: HandoffReplayReport = {
      version: 1,
      evidence: 'deterministic-scripted',
      rows,
      resources: {
        reservedBytesAfter: contextMemoryStore.ledger.reservedBytes,
        persistedDiagnosticJobs: 0
      }
    }
    expect(evaluateHandoffReplay(captured)).toEqual([])
    const out = join(__dirname, '../out/qualification')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'handoff-replay.json'), JSON.stringify(captured, null, 2))
  })
})
