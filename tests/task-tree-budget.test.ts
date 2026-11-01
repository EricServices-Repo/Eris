/* eslint-disable require-yield -- these fake agents act through their callbacks. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Delegate = (req: {
  agentId: string
  goal: string
  summary: string
  handoff: unknown
}) => Promise<{ ok: boolean; detail: string; childJobId?: string }>
type Run = {
  jobId: string
  signal: AbortSignal
  onDelegate: Delegate
  onAwaitChildren: (timeoutMs: number) => Promise<unknown>
  goal: string
  agentId: string
}
const h = vi.hoisted(() => ({
  root: '',
  /** A deterministic fake agent: what it does with its one model call. */
  agent: null as null | ((run: Run) => AsyncGenerator<unknown, void, unknown>),
  modelCalls: 0,
  maxParallel: 6
}))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async (input: { context: { manualAgentId?: string | null } }) => {
    const agentId = input.context.manualAgentId ?? 'a'
    return {
      mode: 'agent',
      agentId,
      agentName: agentId,
      intent: 'edit',
      reason: 'test',
      toolPolicy: 'edit',
      models: { chat: 'local:t', tools: 'local:t' }
    }
  }
}))
vi.mock('../electron/main/services/worktrees', () => ({
  addAgentWorktree: vi.fn(async (_root: string, id: string) => ({
    path: `/worktrees/${id}`,
    branch: `b-${id}`,
    destinationBranch: 'main',
    baseSha: 'a'
  })),
  diffWorktree: vi.fn(),
  mergeAgentBranch: vi.fn(),
  removeAgentWorktree: vi.fn()
}))
vi.mock('../electron/main/services/settings', async (original) => {
  const actual = await original<typeof import('../electron/main/services/settings')>()
  return {
    ...actual,
    getResolvedSettings: () => {
      const settings = structuredClone(actual.getDefaults())
      settings.backgroundAgents.maxParallel = h.maxParallel
      return settings
    }
  }
})
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: async function* (options: Run) {
    h.modelCalls++
    // Imported here: at load time this module is itself being imported by that one.
    const { getBackgroundJob } = await import('../electron/main/services/background-agents')
    const job = getBackgroundJob(options.jobId)!
    yield* h.agent!({ ...options, goal: job.goal, agentId: job.agentId })
  }
}))

import { TASK_TREE_LIMITS } from '../src/shared/agent-orchestration'
import { formatBackgroundJobDetail } from '../src/shared/background-job-detail'

h.root = mkdtempSync(join(tmpdir(), 'eris-tree-'))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const store = () => join(h.root, 'background-jobs.json')
type Agents = typeof import('../electron/main/services/background-agents')
/** Jobs live in the module, so each test loads its own, as a fresh process would. */
let agents: Agents
const loadAgents = async () => {
  vi.resetModules()
  agents = await import('../electron/main/services/background-agents')
  return agents
}

const FINISHED = ['done', 'failed', 'stopped']
const job = (id: string) => agents.getBackgroundJob(id)!
const everything = () => agents.listBackgroundJobs(null)
const quiet = () =>
  vi.waitFor(
    () => expect(everything().every((item) => FINISHED.includes(item.status))).toBe(true),
    { timeout: 4000 }
  )
const root = (goal = 'Fix the build') =>
  agents.enqueueBackgroundJob(h.root, { goal, model: 'local:t', agentId: 'a', source: 'panel' })
const handoff = (goal: string, agentId: string) => ({
  goal,
  summary: 's',
  fromAgentId: 'x',
  toAgentId: agentId
})
const tell = (run: Run, agentId: string, goal: string) =>
  run.onDelegate({ agentId, goal, summary: 's', handoff: handoff(goal, agentId) })
const answers: string[] = []
const remember = (result: { ok: boolean; detail: string }) => {
  if (!result.ok) answers.push(result.detail)
  return result
}
const hang = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })

beforeEach(async () => {
  h.modelCalls = 0
  h.maxParallel = 6
  answers.length = 0
  h.agent = async function* () {}
  rmSync(store(), { force: true })
  await loadAgents()
})
afterEach(async () => {
  vi.useRealTimers()
  await agents.stopAllBackgroundJobs()
  await quiet()
})

describe('runaway delegation', () => {
  it('ends an agent delegating its own goal to itself', async () => {
    h.agent = async function* (run) {
      remember(await tell(run, run.agentId, run.goal))
    }
    const start = root()
    await quiet()
    expect(job(start.id).status).toBe('done')
    expect(h.modelCalls).toBe(1)
    expect(answers[0]).toMatch(/Task budget exhausted \(cycle\)/)
    expect(job(start.id).budgetExhausted).toBe('cycle')
  })

  it('ends an A→B→A cycle', async () => {
    h.agent = async function* (run) {
      remember(await tell(run, run.agentId === 'a' ? 'b' : 'a', run.goal))
    }
    root('Ping pong')
    await quiet()
    expect(h.modelCalls).toBe(2)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatch(/cycle/)
  })

  it('sees through spacing and case in a repeated goal', async () => {
    h.agent = async function* (run) {
      remember(await tell(run, run.agentId, `  ${run.goal.toUpperCase()}  `))
    }
    root('fix   the build')
    await quiet()
    expect(h.modelCalls).toBe(1) // Recognized at once, not one level later.
    expect(answers[0]).toMatch(/cycle/)
  })

  it('stops a chain of ever-new goals at the depth limit', async () => {
    let turn = 0
    h.agent = async function* (run) {
      remember(await tell(run, 'a', `Goal ${++turn}`))
    }
    root()
    await quiet()
    expect(h.modelCalls).toBe(TASK_TREE_LIMITS.depth + 1)
    expect(answers[0]).toMatch(/depth/)
  })

  it('caps a fan-out, counting every agent in the tree', async () => {
    h.maxParallel = 1
    h.agent = async function* (run) {
      if (run.agentId !== 'a') return
      for (let i = 0; i < 40; i++) remember(await tell(run, 'b', `Task ${i}`))
    }
    root()
    await quiet()
    expect(everything()).toHaveLength(TASK_TREE_LIMITS.agents)
    expect(h.modelCalls).toBe(TASK_TREE_LIMITS.agents)
    expect(answers).toHaveLength(40 - (TASK_TREE_LIMITS.agents - 1))
  })
})

describe('legitimate work', () => {
  it('runs independent siblings within the budget, including equal goals', async () => {
    h.agent = async function* (run) {
      if (run.agentId !== 'a') return
      expect((await tell(run, 'b', 'Tests')).ok).toBe(true)
      expect((await tell(run, 'b', 'Docs')).ok).toBe(true)
      expect((await tell(run, 'c', 'Docs')).ok).toBe(true)
      expect((await tell(run, 'b', 'Docs')).ok).toBe(true) // A sibling, not an ancestor.
      await run.onAwaitChildren(5000)
    }
    const start = root()
    await quiet()
    expect(everything()).toHaveLength(5)
    expect(everything().every((item) => item.status === 'done')).toBe(true)
    expect(job(start.id).treeUsage).toMatchObject({ agents: 5, depth: 1 })
    expect(job(start.id).budgetExhausted).toBeUndefined()
  })

  it('lets one agent hand the same goal to a different one', async () => {
    h.agent = async function* (run) {
      if (run.agentId === 'a') expect((await tell(run, 'b', run.goal)).ok).toBe(true)
    }
    root()
    await quiet()
    expect(everything()).toHaveLength(2)
  })

  it('gives each root its own budget', async () => {
    h.agent = async function* (run) {
      if (run.agentId === 'a') for (let i = 0; i < 20; i++) await tell(run, 'b', `T${i}`)
    }
    root('One')
    await quiet()
    const second = root('Two')
    await quiet()
    expect(job(second.id).budgetExhausted).toBe('agents')
    expect(everything().filter((item) => item.tree?.rootId === second.id)).toHaveLength(
      TASK_TREE_LIMITS.agents
    )
  })
})

describe('model work across the tree', () => {
  const step = (value: number) => ({
    type: 'progress',
    step: value,
    actionLog: [],
    filesTouched: []
  })

  it('adds up steps across agents, each of which stays under the limit alone', async () => {
    const each = Math.ceil(TASK_TREE_LIMITS.steps / 2)
    h.agent = async function* (run) {
      yield step(each)
      if (run.agentId === 'a') {
        await tell(run, 'b', 'Second')
        await run.onAwaitChildren(5000)
        remember(await tell(run, 'c', 'Third'))
      }
    }
    const start = root()
    await quiet()
    expect(job(start.id).step).toBe(each)
    expect(job(start.id).treeUsage?.steps).toBe(each * 2)
    expect(answers[0]).toMatch(/\(steps\)/)
  })

  it('stops the tree once its steps run out, and says why', async () => {
    h.agent = async function* (run) {
      yield step(TASK_TREE_LIMITS.steps)
      await hang(run.signal)
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    const start = root()
    await quiet()
    expect(job(start.id)).toMatchObject({ status: 'stopped', budgetExhausted: 'steps' })
    expect(job(start.id).error).toMatch(/Task budget exhausted \(steps\)/)
  })

  it('refuses a child, and fails a queued one, after the steps are spent', async () => {
    h.maxParallel = 1
    let queued: string | undefined
    h.agent = async function* (run) {
      if (run.agentId !== 'a') return
      queued = (await tell(run, 'b', 'Queued first')).childJobId
      yield step(TASK_TREE_LIMITS.steps)
    }
    root()
    await quiet()
    expect(job(queued!)).toMatchObject({ status: 'failed', budgetExhausted: 'steps' })
    expect(h.modelCalls).toBe(1)
  })
})

describe('the root deadline', () => {
  const hour = TASK_TREE_LIMITS.minutes * 60_000

  it('refuses new children after it passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    h.agent = async function* (run) {
      vi.setSystemTime(Date.now() + hour + 1)
      remember(await tell(run, 'b', 'Too late'))
    }
    root()
    await quiet()
    expect(answers[0]).toMatch(/deadline/)
    expect(everything()).toHaveLength(1)
  })

  it('stops an agent that is only waiting, which reports no progress', async () => {
    let timed: (() => void) | undefined
    const real = globalThis.setTimeout
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      work: () => void,
      ms?: number
    ) => {
      if (ms !== undefined && ms > 60_000) {
        timed = work // The budget's timer, held so the test can fire it.
        return 0 as never
      }
      return real(work, ms)
    }) as never)
    h.agent = async function* (run) {
      await hang(run.signal)
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    const start = root()
    await vi.waitFor(() => expect(h.modelCalls).toBe(1))
    timer.mockRestore()
    expect(timed).toBeDefined()
    timed!()
    await quiet()
    expect(job(start.id)).toMatchObject({ status: 'stopped', budgetExhausted: 'deadline' })
  })

  it('keeps the root’s deadline on its children', async () => {
    let child: string | undefined
    h.agent = async function* (run) {
      if (run.agentId === 'a') child = (await tell(run, 'b', 'Child')).childJobId
    }
    const start = root()
    await quiet()
    expect(job(child!).tree).toMatchObject({
      rootId: start.id,
      depth: 1,
      deadlineAt: job(start.id).tree!.deadlineAt
    })
  })
})

describe('reservations', () => {
  it('releases a slot when a queued child is cancelled before it starts', async () => {
    h.maxParallel = 1
    let release = () => {}
    const queued: string[] = []
    h.agent = async function* (run) {
      if (run.agentId !== 'a') return
      for (let i = 0; i < TASK_TREE_LIMITS.agents - 1; i++)
        queued.push((await tell(run, 'b', `T${i}`)).childJobId!)
      expect((await tell(run, 'b', 'One too many')).ok).toBe(false)
      agents.stopBackgroundJob(queued[0]!)
      expect((await tell(run, 'b', 'Now it fits')).ok).toBe(true)
      await new Promise<void>((resolve) => (release = resolve))
    }
    const start = root()
    await vi.waitFor(() => expect(job(start.id).treeUsage?.agents).toBe(TASK_TREE_LIMITS.agents))
    await vi.waitFor(() => expect(everything()).toHaveLength(TASK_TREE_LIMITS.agents + 1))
    release()
    await quiet()
    expect(answers).toEqual([])
  })

  it('keeps counting a job that ran, whatever way it ended', async () => {
    h.agent = async function* (run) {
      if (run.agentId === 'b') throw new Error('Child failed')
      await tell(run, 'b', 'Fails')
      await run.onAwaitChildren(5000)
    }
    const start = root()
    await quiet()
    expect(job(start.id).treeUsage?.agents).toBe(2)
  })
})

describe('a restart', () => {
  const started = '2026-01-01T00:00:00.000Z'
  const saved = (id: string, depth: number, extra: object = {}) => ({
    id,
    workspacePath: h.root,
    worktreePath: '',
    branch: '',
    goal: id,
    model: 'local:t',
    agentId: 'a',
    status: 'done',
    step: 1,
    actionLog: [],
    filesTouched: [],
    answer: '',
    startedAt: started,
    tree: {
      rootId: 'root',
      depth,
      ancestry: [],
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString()
    },
    createdAt: started,
    updatedAt: started,
    ...extra
  })
  const reload = async (jobs: unknown[]) => {
    writeFileSync(store(), JSON.stringify({ jobs }))
    await loadAgents()
  }
  const childOf = (parentId: string) =>
    agents.enqueueBackgroundJob(h.root, {
      goal: 'After restart',
      model: 'local:t',
      agentId: 'z',
      parentId
    })

  it('does not reset what a tree has spent', async () => {
    const children = Array.from({ length: TASK_TREE_LIMITS.agents - 1 }, (_, i) =>
      saved(`c${i}`, 1)
    )
    await reload([saved('root', 0), ...children])
    expect(() => childOf('root')).toThrow(/Task budget exhausted \(agents\)/)
  })

  it('does not reset the depth', async () => {
    await reload([saved('root', 0), saved('deep', TASK_TREE_LIMITS.depth)])
    expect(() => childOf('deep')).toThrow(/Task budget exhausted \(depth\)/)
  })

  it('does not reset the deadline', async () => {
    const past = { rootId: 'root', depth: 0, ancestry: [], deadlineAt: started }
    await reload([saved('root', 0, { tree: past })])
    expect(() => childOf('root')).toThrow(/Task budget exhausted \(deadline\)/)
  })

  it('releases children that were queued when Eris quit and never ran', async () => {
    const waiting = Array.from({ length: TASK_TREE_LIMITS.agents - 1 }, (_, i) =>
      saved(`q${i}`, 1, { status: 'queued', startedAt: undefined })
    )
    await reload([saved('root', 0), ...waiting])
    expect(() => childOf('root')).not.toThrow()
  })

  it('accepts a job saved before trees existed', async () => {
    const { tree: _tree, startedAt: _startedAt, ...legacy } = saved('old', 0)
    await reload([legacy])
    const child = childOf('old')
    expect(child.tree).toMatchObject({ rootId: 'old', depth: 1 })
  })
})

describe('diagnostics', () => {
  it('shows tree usage apart from the job’s own steps', async () => {
    h.agent = async function* (run) {
      yield { type: 'progress', step: 7, actionLog: [], filesTouched: [] }
      if (run.agentId === 'a') await tell(run, 'b', 'Child')
    }
    const start = root()
    await quiet()
    const detail = formatBackgroundJobDetail(job(start.id), '')
    expect(detail).toContain(
      `task tree: depth 1/${TASK_TREE_LIMITS.depth} · 2/${TASK_TREE_LIMITS.agents} agents`
    )
    expect(job(start.id).step).toBe(7)
  })

  it('names the limit that stopped a tree', async () => {
    h.agent = async function* (run) {
      await tell(run, run.agentId, run.goal)
    }
    const start = root()
    await quiet()
    expect(formatBackgroundJobDetail(job(start.id), '')).toContain('exhausted: cycle')
  })
})
