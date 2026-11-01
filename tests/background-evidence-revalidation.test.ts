import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  root: '',
  sent: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>,
  planned: 0,
  hold: new Map<string, Promise<void>>(),
  open: [] as Array<() => void>,
  duringRun: null as null | (() => Promise<void>)
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
  prepareModelWindows: async () => undefined
}))
vi.mock('../electron/main/services/openai-compatible', async (original) => ({
  ...(await original<object>()),
  streamOpenAICompatible: async function* (request: (typeof h.sent)[number]) {
    h.sent.push(request)
    yield 'ok'
  }
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => {
    h.planned++
    return {
      mode: 'agent',
      agentId: 'reviewer',
      agentName: 'Reviewer',
      intent: 'review',
      reason: 'test',
      toolPolicy: 'read',
      models: { chat: 'local-model', tools: 'local-model' }
    }
  }
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
// A runner reduced to what matters here: it sends its handoff through the real transport.
vi.mock('../electron/main/services/agent-runner', async () => {
  const { streamModelChat } = await import('../electron/main/services/chat-runtime')
  return {
    runAgentWithWorkspaceTools: async function* (options: {
      jobId: string
      settings: AppSettings
      messages: Array<{ role: 'user'; content: string }>
    }) {
      await h.hold.get(options.jobId)
      const job = (await import('../electron/main/services/background-agents')).getBackgroundJob(
        options.jobId
      )
      await h.duringRun?.()
      for await (const text of streamModelChat({
        settings: options.settings,
        model: job!.goal.startsWith('remote') ? 'remote-model' : 'local-model',
        messages: options.messages,
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
import {
  captureHandoffEvidence,
  leaseMemoryEvidence,
  runInEvidenceScope,
  runWithHandoffEvidence,
  withEligibleMemory
} from '../electron/main/services/memory-dispatch'
import {
  delegateFromAgent,
  enqueueBackgroundJob,
  getBackgroundJob,
  stopAllBackgroundJobs
} from '../electron/main/services/background-agents'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import * as profileSettings from '../electron/main/services/settings'
import { getDefaults } from '../electron/main/services/settings'
import { emptyMemoryControls } from '../src/shared/context-memory'
import { parseHandoff, type AgentHandoffPacket } from '../src/shared/agent-orchestration'
import type { AppSettings } from '../src/shared/settings-schema'

h.root = mkdtempSync(join(tmpdir(), 'eris-revalidate-'))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

let folder: string
let db: ChatDatabase
let release: () => void

const withSettings = (patch: Partial<AppSettings['agent']['contextMemory']> = {}, parallel = 6) => {
  const value = structuredClone(getDefaults())
  Object.assign(value.agent.contextMemory, { foregroundDeadlineMs: 2000 }, patch)
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

const message = (id: string, content: string) => ({
  id,
  role: 'user' as const,
  content,
  createdAt: 1
})
const thread = (...messages: ReturnType<typeof message>[]) => ({
  id: 't',
  title: 'History',
  model: 'local-model',
  createdAt: 1,
  updatedAt: 1,
  messages
})
const history = [
  message('a', 'Remember: checkout uses PRIVATE-A currency'),
  message('b', 'Remember: checkout keeps KEPT-B rounding'),
  message('c', 'Unrelated closing note')
]

const forget = (...forgotten: string[]) =>
  saveMemoryControls(null, 't', { ...emptyMemoryControls(), forgotten })

/** A coordinator that recalled private text, showed it to a local model, then delegates. */
async function coordinator(run: (scope: object) => Promise<void> | void) {
  const scope = {}
  await runInEvidenceScope(async () => {
    const value = profileSettings.getResolvedSettings(null)
    const { prompt } = await conversationContext(null, 't', 'checkout', value)
    release = leaseMemoryEvidence({ root: null, threadId: 't', taskId: 'parent', prompt })
    for await (const _ of streamModelChat({
      settings: value,
      model: 'local-model',
      messages: [
        { role: 'system', content: prompt.text },
        { role: 'user', content: 'What about checkout?' }
      ],
      temperature: 0,
      getSecret: () => null
    }));
    await run(scope)
  }, scope)
}

const packet = (goal: string): AgentHandoffPacket => ({
  goal,
  summary: 'The coordinator found that checkout uses PRIVATE-A currency',
  fromAgentId: 'coordinator',
  toAgentId: 'reviewer'
})
const delegate = (goal: string) =>
  delegateFromAgent({
    workspacePath: h.root,
    model: 'local-model',
    agentId: 'reviewer',
    goal,
    summary: 'derived',
    handoff: packet(goal)
  })
const finished = (id: string) =>
  vi.waitFor(() => expect(['done', 'failed', 'stopped']).toContain(getBackgroundJob(id)?.status), {
    timeout: 3000
  })
const sentByChild = () => h.sent.slice(1)
const leaked = () => JSON.stringify(sentByChild()).includes('PRIVATE-A')

/** Fills the only slot so the next job stays queued until `open` is called. */
function occupySlot() {
  let open = () => {}
  const blocker = enqueueBackgroundJob(h.root, { goal: 'blocker', model: 'local-model' })
  h.hold.set(blocker.id, new Promise<void>((resolve) => (open = resolve)))
  h.open.push(() => open())
  return { blocker, open: () => open() }
}
/** A child delegated while the parent lives, still queued when the parent's lease ends. */
async function queuedChild(goal: string) {
  const { blocker, open } = occupySlot()
  let child!: ReturnType<typeof delegate>
  await coordinator(() => {
    child = delegate(goal)
  })
  expect(getBackgroundJob(child.id)?.status).toBe('queued')
  release()
  return {
    child,
    start: async () => {
      open()
      await finished(blocker.id)
      await finished(child.id)
    }
  }
}

beforeEach(() => {
  h.sent.length = 0
  h.planned = 0
  h.duringRun = null
  h.hold.clear()
  release = () => undefined
  contextMemoryStore.clear()
  folder = mkdtempSync(join(tmpdir(), 'eris-revalidate-db-'))
  db = new ChatDatabase(folder)
  vi.mocked(workspaceRequest).mockImplementation(
    async (req) =>
      (await handleWorkspaceRequest({ ...req, dir: folder } as WorkspaceRequest)) as never
  )
  db.save(thread(...history))
})
afterEach(async () => {
  release()
  for (const open of h.open.splice(0)) open() // A failed test must not hold the only slot.
  await stopAllBackgroundJobs()
  vi.restoreAllMocks()
  closeChatDatabases()
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('a queued handoff after its parent ended', () => {
  it('cannot reach an unapproved remote model', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('remote review')
    await start()
    expect(getBackgroundJob(child.id)).toMatchObject({ status: 'failed' })
    expect(getBackgroundJob(child.id)?.error).toMatch(/local-only conversation memory/)
    expect(leaked()).toBe(false)
  })

  it('still runs on a local model while its evidence stands', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('done')
    expect(leaked()).toBe(true)
  })

  it('still runs when later messages arrive in the thread', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    db.save(thread(...history, message('d', 'A newer unrelated turn')))
    invalidateConversationMemory(null, 't')
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('done')
  })

  it('stops when a source it used is forgotten before it starts', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    await forget('a')
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(getBackgroundJob(child.id)?.error).toMatch(/changed or been removed/)
    expect(h.planned).toBe(1) // Only the blocker: the router never read this handoff.
    expect(leaked()).toBe(false)
  })

  it('stops when a source it used is rewritten before it starts', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    db.save(thread(message('a', 'Remember: checkout uses NEW-CURRENCY'), ...history.slice(1)))
    invalidateConversationMemory(null, 't')
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(leaked()).toBe(false)
  })

  it('stops when the conversation is deleted before it starts', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    db.remove('t')
    invalidateConversationMemory(null, 't')
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(leaked()).toBe(false)
  })

  it('stops when recall is turned off before it starts', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    use(withSettings({ enabled: false }, 1))
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(leaked()).toBe(false)
  })

  it('honours sharing being withdrawn between enqueue and start', async () => {
    use(withSettings({ shareWithRemoteModels: true }, 1))
    const { child, start } = await queuedChild('remote review')
    use(withSettings({}, 1))
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(leaked()).toBe(false)
  })

  it('goes to a remote model the user approved for sharing', async () => {
    use(withSettings({ shareWithRemoteModels: true }, 1))
    const { child, start } = await queuedChild('remote review')
    await start()
    expect(getBackgroundJob(child.id)?.status).toBe('done')
    expect(leaked()).toBe(true)
  })
})

describe('a running child', () => {
  it('stops at its next model call when a source is forgotten mid-run', async () => {
    use(withSettings())
    h.duringRun = () => forget('a').then(() => {})
    let child!: ReturnType<typeof delegate>
    await coordinator(() => {
      child = delegate('local review')
    })
    release()
    await finished(child.id)
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(leaked()).toBe(false)
  })

  it('keeps its evidence when the parent ends while it runs', async () => {
    use(withSettings())
    let child!: ReturnType<typeof delegate>
    let open = () => {}
    await coordinator(() => {
      child = delegate('remote review')
      h.hold.set(child.id, new Promise<void>((resolve) => (open = resolve)))
    })
    release()
    open()
    await finished(child.id)
    expect(getBackgroundJob(child.id)?.status).toBe('failed')
    expect(leaked()).toBe(false)
  })
})

describe('the saved record', () => {
  it('holds references and a ceiling, not the recalled text', async () => {
    use(withSettings({}, 1))
    const { child, start } = await queuedChild('local review')
    const evidence = getBackgroundJob(child.id)?.handoff?.evidence
    expect(evidence).toHaveLength(1)
    expect(evidence![0]).toMatchObject({ threadId: 't', allowRemote: false })
    expect(evidence![0]!.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE-A')
    expect(JSON.stringify(evidence)).not.toContain('checkout uses')
    await start()
  })

  it('survives saving, so a restarted job is checked without any lease', async () => {
    use(withSettings())
    let evidence: AgentHandoffPacket['evidence']
    await coordinator(() => {
      evidence = captureHandoffEvidence()
    })
    release()
    await forget('a')
    const saved = JSON.parse(JSON.stringify({ ...packet('local review'), evidence }))
    const job = enqueueBackgroundJob(h.root, {
      goal: 'local review',
      model: 'local-model',
      handoff: saved
    })
    expect(job.handoff?.evidence).toEqual(parseHandoff(saved).ok && evidence)
    await finished(job.id)
    expect(getBackgroundJob(job.id)?.status).toBe('failed')
    expect(h.planned).toBe(0)
    const file = readFileSync(join(h.root, 'background-jobs.json'), 'utf8')
    expect(JSON.parse(file).jobs.at(-1).handoff.evidence).toBeDefined()
  })

  const captured = async () => {
    let evidence: AgentHandoffPacket['evidence']
    await coordinator(() => {
      evidence = captureHandoffEvidence()
    })
    release()
    return JSON.parse(JSON.stringify(evidence)) as NonNullable<AgentHandoffPacket['evidence']>
  }
  const runSaved = async (evidence: AgentHandoffPacket['evidence']) => {
    const job = enqueueBackgroundJob(h.root, {
      goal: 'local review',
      model: 'local-model',
      handoff: { ...packet('local review'), evidence }
    })
    await finished(job.id)
    return getBackgroundJob(job.id)
  }

  it('warms a cold cache rather than treat a restart as a revocation', async () => {
    use(withSettings())
    const evidence = await captured()
    contextMemoryStore.clear() // A new process holds nothing in RAM.
    expect(await runSaved(evidence)).toMatchObject({ status: 'done' })
  })

  it('refuses an item it has no way to compare', async () => {
    use(withSettings())
    const evidence = await captured()
    for (const item of evidence[0]!.items) delete item.offset
    expect(await runSaved(evidence)).toMatchObject({ status: 'failed' })
  })

  describe('a pinned item', () => {
    const pin = { id: 'pin', text: 'checkout pin PRIVATE-PIN' }
    const pinned = async () => {
      use(withSettings())
      const controls = await saveMemoryControls(null, 't', {
        ...emptyMemoryControls(),
        pinned: [pin]
      })
      const evidence = await captured()
      expect(evidence[0]!.items.some((item) => item.kind === 'pinned')).toBe(true)
      return { controls, evidence }
    }

    it('stands while the pin is unchanged', async () => {
      expect(await runSaved((await pinned()).evidence)).toMatchObject({ status: 'done' })
    })

    it('falls when the pin is edited after the handoff was written', async () => {
      const { controls, evidence } = await pinned()
      await saveMemoryControls(null, 't', {
        ...controls,
        pinned: [{ ...pin, text: 'checkout pin CHANGED-PIN!' }]
      })
      expect(await runSaved(evidence)).toMatchObject({ status: 'failed' })
    })
  })

  it('fails closed on an evidence record it cannot read', () => {
    expect(() =>
      enqueueBackgroundJob(h.root, {
        goal: 'g',
        model: 'local-model',
        handoff: { ...packet('g'), evidence: [{ threadId: 't' }] } as never
      })
    ).toThrow(/evidence record is not valid/)
  })

  it('records nothing for a coordinator that never showed recall to a model', async () => {
    use(withSettings())
    await runInEvidenceScope(async () => {
      const value = profileSettings.getResolvedSettings(null)
      const { prompt } = await conversationContext(null, 't', 'checkout', value)
      release = leaseMemoryEvidence({ root: null, threadId: 't', taskId: 'parent', prompt })
      expect(captureHandoffEvidence()).toEqual([])
    })
  })
})

describe('tracking', () => {
  it('passes the first ceiling down a chain of children', async () => {
    use(withSettings())
    let evidence: AgentHandoffPacket['evidence']
    await coordinator(() => {
      evidence = captureHandoffEvidence()
    })
    release()
    const held = runWithHandoffEvidence(evidence, () => captureHandoffEvidence())
    expect(held).toEqual(evidence)
  })

  it('needs no process-wide state: one job ending leaves an overlapping one bound', async () => {
    use(withSettings())
    let evidence: AgentHandoffPacket['evidence']
    await coordinator(() => {
      evidence = captureHandoffEvidence()
    })
    release()
    const check = () => withEligibleMemory([], 'remote-model', withSettings())
    await expect(
      Promise.all([
        runWithHandoffEvidence(evidence, () => Promise.resolve('finished first')),
        runWithHandoffEvidence(evidence, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return check()
        })
      ])
    ).rejects.toThrow(/local-only/)
  })

  it('leaves work outside a handoff alone', async () => {
    use(withSettings())
    await coordinator(() => undefined)
    release()
    const messages = [{ role: 'user', content: 'Hello' }]
    const out = await runInEvidenceScope(() =>
      withEligibleMemory(messages, 'remote-model', withSettings())
    )
    expect(out.messages).toBe(messages)
  })

  it('does not take evidence from another job through a shared pump', async () => {
    use(withSettings())
    let evidence: AgentHandoffPacket['evidence']
    await coordinator(() => {
      evidence = captureHandoffEvidence()
    })
    release()
    const job = runWithHandoffEvidence(evidence, () =>
      enqueueBackgroundJob(h.root, { goal: 'remote plain task', model: 'local-model' })
    )
    await finished(job.id)
    expect(getBackgroundJob(job.id)?.status).toBe('done')
  })
})
