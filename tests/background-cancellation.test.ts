import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Barrier = { release: () => void; wait: Promise<void> }
const barrier = (): Barrier => {
  let release = () => undefined as void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, wait }
}
const h = vi.hoisted(() => ({
  root: '',
  log: [] as string[],
  started: new Set<string>(),
  ignoreAbort: new Map<string, { wait: Promise<void> }>(),
  planHold: null as null | Promise<void>,
  awaitChildren: new Map<string, Promise<void>>(),
  maxParallel: 6,
  removed: [] as string[]
}))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => {
    if (h.planHold) await h.planHold
    return {
      mode: 'agent',
      agentId: 'composer',
      agentName: 'Composer',
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
    branch: `branch-${id}`,
    destinationBranch: 'main',
    baseSha: 'a'
  })),
  diffWorktree: vi.fn(),
  mergeAgentBranch: vi.fn(async () => ({ ok: true, commit: 'c' })),
  removeAgentWorktree: vi.fn(async (_root: string, tree: { path: string }) => {
    h.log.push(`remove ${tree.path}`)
    h.removed.push(tree.path)
  })
}))
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: async function* (options: {
    jobId: string
    signal: AbortSignal
    onAwaitChildren: (timeoutMs: number) => Promise<unknown>
  }) {
    h.started.add(options.jobId)
    const ready = h.awaitChildren.get(options.jobId)
    if (ready) {
      await ready
      await options.onAwaitChildren(60_000)
    }
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve()
      else options.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    // A child paused before a write: it does not stop the moment it is told to.
    await h.ignoreAbort.get(options.jobId)?.wait
    h.log.push(`finished ${options.jobId}`)
    throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    yield undefined
  }
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

import {
  delegateFromAgent,
  discardBackgroundJob,
  enqueueBackgroundJob,
  getBackgroundJob,
  mergeBackgroundJob,
  stopBackgroundJob
} from '../electron/main/services/background-agents'

h.root = mkdtempSync(join(tmpdir(), 'eris-cancel-'))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => {
  h.log.length = 0
  h.removed.length = 0
  h.started.clear()
  h.ignoreAbort.clear()
  h.awaitChildren.clear()
  h.planHold = null
  h.maxParallel = 6
})

// These poll for an end state, so a long limit only slows a failure, never a pass.
vi.setConfig({ testTimeout: 30_000 })
const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 10 })
const root = (goal = 'Parent') => enqueueBackgroundJob(h.root, { goal, model: 'local:t' })
const child = (parentJobId: string, goal = 'Child') =>
  delegateFromAgent({
    workspacePath: h.root,
    parentJobId,
    model: 'local:t',
    agentId: 'composer',
    goal,
    summary: 's',
    handoff: { goal, summary: 's', fromAgentId: 'a', toAgentId: 'b' }
  })
const running = (id: string) => until(() => expect(h.started.has(id)).toBe(true))
const status = (id: string) => getBackgroundJob(id)?.status
const treeOf = async () => {
  const parent = root()
  await running(parent.id)
  await until(() => expect(getBackgroundJob(parent.id)?.worktreePath).toBeTruthy())
  return parent
}

describe('stopping a job tree', () => {
  it('stops running and queued descendants, and leaves other trees alone', async () => {
    const parent = await treeOf()
    const other = await treeOf()
    const kid = child(parent.id)
    await running(kid.id)
    const grandkid = child(kid.id)
    await running(grandkid.id)
    expect(stopBackgroundJob(parent.id)).toBe(true)
    await until(() => {
      expect(status(parent.id)).toBe('stopped')
      expect(status(kid.id)).toBe('stopped')
      expect(status(grandkid.id)).toBe('stopped')
    })
    expect(status(other.id)).toBe('running')
    stopBackgroundJob(other.id)
  })

  it('never starts a queued descendant once its root is cancelled', async () => {
    const parent = await treeOf()
    h.maxParallel = 1
    const queued = child(parent.id)
    expect(status(queued.id)).toBe('queued')
    h.maxParallel = 6
    stopBackgroundJob(parent.id)
    await until(() => expect(status(parent.id)).toBe('stopped'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(status(queued.id)).toBe('stopped')
    expect(h.started.has(queued.id)).toBe(false)
  })

  it('refuses a new child under a stopping root', async () => {
    const parent = await treeOf()
    h.ignoreAbort.set(parent.id, barrier())
    stopBackgroundJob(parent.id)
    expect(() => child(parent.id)).toThrow('stopping')
    h.ignoreAbort.get(parent.id)!.wait = Promise.resolve()
  })

  it('refuses a new child under a stopped root', async () => {
    const parent = await treeOf()
    stopBackgroundJob(parent.id)
    await until(() => expect(status(parent.id)).toBe('stopped'))
    expect(() => child(parent.id)).toThrow('stopping')
  })

  it('stops a parent blocked in await_children, with its children', async () => {
    const hasChild = barrier()
    const parent = root()
    h.awaitChildren.set(parent.id, hasChild.wait)
    await running(parent.id)
    await until(() => expect(getBackgroundJob(parent.id)?.worktreePath).toBeTruthy())
    const kid = child(parent.id)
    await running(kid.id)
    hasChild.release()
    await until(() => expect(getBackgroundJob(parent.id)?.waitReason).toBe('children'))
    stopBackgroundJob(parent.id)
    await until(() => {
      expect(status(parent.id)).toBe('stopped')
      expect(status(kid.id)).toBe('stopped')
    })
  })

  it('is safe to repeat', async () => {
    const parent = await treeOf()
    stopBackgroundJob(parent.id)
    stopBackgroundJob(parent.id)
    await until(() => expect(status(parent.id)).toBe('stopped'))
    // Stopped is recorded before the job finishes its cleanup, so this settles rather than flips.
    await until(() => expect(stopBackgroundJob(parent.id)).toBe(false))
    expect(status(parent.id)).toBe('stopped')
  })
})

describe('discarding a job tree', () => {
  it('removes a shared worktree only after the child using it has finished', async () => {
    const parent = await treeOf()
    const kid = child(parent.id)
    await running(kid.id)
    const paused = barrier()
    h.ignoreAbort.set(kid.id, paused)
    const discard = discardBackgroundJob(parent.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.removed).toEqual([])
    paused.release()
    await discard
    const tree = `/worktrees/${parent.id}`
    expect(h.log.indexOf(`finished ${kid.id}`)).toBeLessThan(h.log.indexOf(`remove ${tree}`))
    expect(h.removed).toEqual([tree])
    expect(status(parent.id)).toBe('discarded')
    expect(status(kid.id)).toBe('discarded')
  })

  it('keeps the worktree and says so if a child will not stop in time', async () => {
    const parent = await treeOf()
    const kid = child(parent.id)
    await running(kid.id)
    const paused = barrier()
    h.ignoreAbort.set(kid.id, paused)
    const job = await discardBackgroundJob(parent.id, 20)
    expect(h.removed).toEqual([])
    expect(job.worktreeRetained).toBe(true)
    expect(job.status).not.toBe('discarded')
    expect(job.liveStatus).toContain('worktree was kept')
    paused.release()
    await until(() => expect(status(kid.id)).toBe('stopped'))
    const retried = await discardBackgroundJob(parent.id)
    expect(retried).toMatchObject({ status: 'discarded', worktreeRetained: false })
    expect(h.removed).toEqual([`/worktrees/${parent.id}`])
  })

  it('leaves a child with its own worktree to be reviewed', async () => {
    const parent = await treeOf()
    const own = enqueueBackgroundJob(h.root, {
      goal: 'Separate',
      model: 'local:t',
      parentId: parent.id
    })
    await running(own.id)
    await until(() => expect(getBackgroundJob(own.id)?.worktreePath).toBeTruthy())
    await discardBackgroundJob(parent.id)
    expect(h.removed).toEqual([`/worktrees/${parent.id}`])
    expect(status(own.id)).toBe('stopped')
  })

  it('removes the worktree once when discard is repeated', async () => {
    const parent = await treeOf()
    await Promise.all([discardBackgroundJob(parent.id), discardBackgroundJob(parent.id)])
    await discardBackgroundJob(parent.id)
    expect(h.removed).toHaveLength(1)
  })

  it('finds a worktree created after the discard began', async () => {
    let finishPlanning = () => undefined as void
    h.planHold = new Promise((resolve) => {
      finishPlanning = resolve
    })
    const parent = root()
    await until(() => expect(status(parent.id)).toBe('running'))
    const discard = discardBackgroundJob(parent.id)
    h.planHold = null
    finishPlanning()
    const job = await discard
    expect(job.status).toBe('discarded')
    expect(h.started.has(parent.id)).toBe(false)
    expect(getBackgroundJob(parent.id)?.worktreePath).toBeFalsy()
    expect(h.removed).toEqual([])
  })

  it('does not take a shared worktree away from a parent when a child is discarded', async () => {
    const parent = await treeOf()
    const kid = child(parent.id)
    await running(kid.id)
    await discardBackgroundJob(kid.id)
    expect(h.removed).toEqual([])
    expect(status(kid.id)).toBe('discarded')
    expect(status(parent.id)).toBe('running')
    stopBackgroundJob(parent.id)
  })
})

describe('merging', () => {
  it('will not remove a worktree under a running child', async () => {
    const parent = await treeOf()
    const kid = child(parent.id)
    await running(kid.id)
    const internal = getBackgroundJob(parent.id)!
    Object.assign(internal, { status: 'done' })
    await expect(mergeBackgroundJob(parent.id)).rejects.toThrow('still running')
    Object.assign(internal, { status: 'running' })
    stopBackgroundJob(parent.id)
  })
})
