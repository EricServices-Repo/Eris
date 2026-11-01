import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const h = vi.hoisted(() => ({ root: '' }))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<object>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => ({
    mode: 'agent',
    intent: 'edit',
    agentId: 'composer',
    agentName: 'Composer',
    reason: 'fixture',
    toolPolicy: 'edit',
    models: { chat: 'local:test', tools: 'local:test' }
  })
}))
vi.mock('../electron/main/services/worktrees', () => ({
  addAgentWorktree: async (_root: string, id: string) => {
    const path = join(h.root, id)
    mkdirSync(path)
    return { path, branch: id, destinationBranch: 'main', baseSha: 'base' }
  },
  mergeAgentBranch: async (_root: string, branch: string) => {
    copyFileSync(join(h.root, branch, 'app.ts'), join(h.root, 'app.ts'))
    return { ok: true, commit: 'merged' }
  },
  removeAgentWorktree: async () => {},
  diffWorktree: async () => ({ ok: true, diff: '' })
}))
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: async function* (options: {
    jobId: string
    workspacePath: string
    messages: Array<{ content: string }>
  }) {
    const job = (await import('../electron/main/services/background-agents')).getBackgroundJob(
      options.jobId
    )!
    if (job.goal !== 'prose') {
      writeFileSync(join(options.workspacePath, 'app.ts'), 'export const result = 42')
      yield {
        type: 'diff',
        diff: {
          checkpointId: 'check',
          opIndex: 1,
          path: 'app.ts',
          before: null,
          after: 'export const result = 42',
          op: 'write'
        }
      }
      yield {
        type: 'tool',
        tool: {
          id: 'check',
          name: 'verify',
          path: 'npm test',
          status: 'ok',
          detail: 'fixture check passed'
        }
      }
    }
    yield { type: 'answer', text: 'Everything is complete.' }
    yield {
      type: 'progress',
      step: 1,
      actionLog: [],
      filesTouched: job.goal === 'prose' ? [] : ['app.ts'],
      incomplete: job.goal === 'partial'
    }
  }
}))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import { closeChatDatabases } from '../electron/main/services/chat-database'
import {
  enqueueBackgroundJob,
  getBackgroundJob,
  bringJobIntoChat,
  mergeBackgroundJob
} from '../electron/main/services/background-agents'
import { getChat } from '../electron/main/services/chats'
import { conversationContext } from '../electron/main/services/context-memory'
import { getDefaults } from '../electron/main/services/settings'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
h.root = mkdtempSync(join(tmpdir(), 'eris-child-outcome-'))
afterAll(() => {
  closeChatDatabases()
  rmSync(h.root, { recursive: true, force: true })
})
beforeEach(() => {
  vi.mocked(workspaceRequest).mockImplementation(
    async (req) => (await handleWorkspaceRequest(req as WorkspaceRequest)) as never
  )
})

async function finished(goal: string) {
  const job = enqueueBackgroundJob(h.root, {
    goal,
    model: 'local:test',
    sourceThreadId: 'original-source'
  })
  await vi.waitFor(() => expect(getBackgroundJob(job.id)?.outcome).toBeDefined(), { timeout: 3000 })
  return getBackgroundJob(job.id)!
}
describe('typed child imports (#264)', () => {
  it('persists unapplied verified checks as unverified workspace effects and imports once', async () => {
    const job = await finished('verified')
    expect(job.outcome?.receipt).toMatchObject({
      status: 'done',
      integration: 'unapplied',
      verification: 'passed',
      observed: false
    })
    const first = await bringJobIntoChat(h.root, job.id)
    const second = await bringJobIntoChat(h.root, job.id)
    expect(second.threadId).toBe(first.threadId)
    const thread = await getChat(h.root, first.threadId)
    expect(thread?.messageCount).toBe(1)
    expect(thread?.messages[0]?.contextResult?.childOutcome).toMatchObject({
      integration: 'unapplied',
      observed: false
    })
    expect(getBackgroundJob(job.id)?.sourceThreadId).toBe('original-source')
  })
  it('keeps failed partial edits and prose-only success unverified', async () => {
    for (const goal of ['partial', 'prose']) {
      const job = await finished(goal)
      const imported = await bringJobIntoChat(h.root, job.id)
      const thread = await getChat(h.root, imported.threadId)
      const receipt = thread?.messages[0]?.contextResult?.childOutcome
      expect(receipt?.observed).toBe(false)
      if (goal === 'partial') expect(receipt).toMatchObject({ status: 'failed' })
      else expect(receipt?.effects).toEqual([])
    }
  })
  it('binds integrated effects to source snapshots and invalidates changed dependencies', async () => {
    const job = await finished('to-merge')
    await mergeBackgroundJob(job.id)
    const imported = await bringJobIntoChat(h.root, job.id)
    const thread = await getChat(h.root, imported.threadId)
    const receipt = thread?.messages[0]?.contextResult
    expect(receipt?.childOutcome).toMatchObject({
      integration: 'integrated',
      observed: true,
      verification: 'stale'
    })
    expect(receipt?.dependencies?.complete).toBe(true)
    const settings = structuredClone(getDefaults())
    settings.agent.contextMemory.foregroundDeadlineMs = 2000
    const before = await conversationContext(h.root, imported.threadId, 'task app.ts', settings)
    expect(before.inspection.facts.some((fact) => fact.kind === 'task-result')).toBe(true)
    writeFileSync(join(h.root, 'app.ts'), 'changed after import')
    const after = await conversationContext(h.root, imported.threadId, 'task app.ts', settings)
    expect(after.inspection.facts.some((fact) => fact.kind === 'task-result')).toBe(false)
  })
})
