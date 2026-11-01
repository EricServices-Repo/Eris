import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  root: '',
  seen: new Map<string, unknown>(),
  gate: Promise.resolve() as Promise<void>
}))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => ({
    agentId: 'composer',
    agentName: 'Composer',
    intent: 'edit',
    reason: 'test',
    toolPolicy: 'edit',
    models: { chat: 'local:t', tools: 'local:t' }
  })
}))
vi.mock('../electron/main/services/worktrees', () => ({
  addAgentWorktree: vi.fn(async () => ({
    path: h.root,
    branch: 'b',
    destinationBranch: 'main',
    baseSha: 'a'
  })),
  diffWorktree: vi.fn(),
  mergeAgentBranch: vi.fn(),
  removeAgentWorktree: vi.fn()
}))
vi.mock('../electron/main/services/agent-runner', async () => {
  const { currentEvidenceScope } = await import('../electron/main/services/memory-dispatch')
  return {
    runAgentWithWorkspaceTools: async function* (options: { jobId: string }) {
      h.seen.set(options.jobId, currentEvidenceScope())
      await h.gate
      yield { type: 'answer', text: 'ok' }
    }
  }
})

import {
  delegateFromAgent,
  enqueueBackgroundJob,
  getBackgroundJob,
  stopAllBackgroundJobs
} from '../electron/main/services/background-agents'
import { runInEvidenceScope } from '../electron/main/services/memory-dispatch'

h.root = mkdtempSync(join(tmpdir(), 'eris-scope-'))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => h.seen.clear())

const settled = (id: string) =>
  vi.waitFor(
    () => {
      expect(h.seen.has(id)).toBe(true)
      expect(getBackgroundJob(id)?.status).not.toBe('running')
    },
    { timeout: 2_000 }
  )
const handoff = { goal: 'g', summary: 's', fromAgentId: 'a', toAgentId: 'b' }

describe('background jobs and recall scope', () => {
  it('runs a delegated job in the scope of the request that delegated it', async () => {
    const scope = {}
    const job = runInEvidenceScope(
      () =>
        delegateFromAgent({
          workspacePath: h.root,
          model: 'local:t',
          agentId: 'composer',
          goal: 'Child work',
          summary: 's',
          handoff
        }),
      scope
    )
    await settled(job.id)
    expect(h.seen.get(job.id)).toBe(scope)
  })

  it('does not hand a panel job the scope of whatever request woke the queue', async () => {
    const scope = {}
    const job = runInEvidenceScope(
      () =>
        enqueueBackgroundJob(h.root, { goal: 'Independent', model: 'local:t', source: 'panel' }),
      scope
    )
    await settled(job.id)
    expect(h.seen.get(job.id)).toBeDefined()
    expect(h.seen.get(job.id)).not.toBe(scope)
  })

  it('gives independent jobs different scopes', async () => {
    const one = enqueueBackgroundJob(h.root, { goal: 'One', model: 'local:t' })
    await settled(one.id)
    const two = enqueueBackgroundJob(h.root, { goal: 'Two', model: 'local:t' })
    await settled(two.id)
    expect(h.seen.get(one.id)).not.toBe(h.seen.get(two.id))
    await stopAllBackgroundJobs()
  })
})
