import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<object>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import { chatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import { workspaceChatsDir } from '../electron/main/services/paths'
import { rememberWorkspace } from '../electron/main/services/workspace'
import { getResolvedSettings } from '../electron/main/services/settings'
import { saveMemoryControls } from '../electron/main/services/context-memory'
import { createContextOrigin } from '../electron/main/services/context-origin'
import { ContextPull, taskThreadRecall } from '../electron/main/services/agent/context-pull'
import { RunJournal } from '../electron/main/services/agent/run-journal'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { childTaskContract, createTaskContract } from '../electron/main/services/task-intake'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { TaskContract } from '../src/shared/task-contract'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'

let folder: string, source: string, child: string, priorProfile: string | undefined
const plan = {
  mode: 'agent',
  intent: 'review',
  toolPolicy: 'read',
  agentId: 'reviewer',
  models: { chat: 'local:test', tools: 'local:test' }
} as never

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'eris-handle-')))
  source = join(folder, 'source')
  child = join(folder, 'child')
  for (const dir of [source, child, join(source, 'app'), join(child, 'app')]) mkdirSync(dir)
  priorProfile = process.env.ERIS_TEST_APPDATA
  process.env.ERIS_TEST_APPDATA = join(folder, 'profile')
  rememberWorkspace(source)
  const db = chatDatabase(workspaceChatsDir(source))
  const message = (id: string, content: string) => ({
    id,
    role: 'user' as const,
    content,
    createdAt: 1,
    contextProjectRoot: join(source, 'app')
  })
  db.save({
    id: 't',
    title: 'Parent',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      message('currency', 'Remember: booking receipts use CAD currency'),
      message('timezone', 'Remember: booking times are stored in UTC'),
      ...Array.from({ length: 30 }, (_, i) => message(`n${i}`, `Status update ${i}`))
    ]
  })
  db.save({
    id: 'other',
    title: 'Unrelated',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: [message('secret', 'Remember: payroll export password policy is private')]
  })
  vi.mocked(workspaceRequest).mockImplementation(
    async (req) => (await handleWorkspaceRequest(req as WorkspaceRequest)) as never
  )
})
afterEach(() => {
  closeChatDatabases()
  contextMemoryStore.clear()
  process.env.ERIS_TEST_APPDATA = priorProfile
  if (priorProfile === undefined) delete process.env.ERIS_TEST_APPDATA
  rmSync(folder, { recursive: true, force: true })
})

async function parentTask(): Promise<TaskContract> {
  const parent = createTaskContract({
    workspacePath: source,
    text: 'Review the booking project',
    threadId: 't',
    taskId: 'parent',
    plan
  })
  parent.scope.projectRoot = join(source, 'app')
  parent.contextOrigin = await createContextOrigin({
    sourceRoot: source,
    projectRoot: join(source, 'app'),
    threadId: 't',
    taskId: 'parent'
  })
  return parent
}
/** A specialist delegated from the parent, running in its own worktree, as loop.ts does. */
const specialist = (parent: TaskContract, goal: string, id: string) =>
  childTaskContract(parent, plan, goal, child, id)

function pull(task: TaskContract, allowed = true) {
  const journal = new RunJournal({
    runId: task.taskId,
    taskId: task.taskId,
    memoryKey: task.taskId
  })
  const tools = new ContextPull({
    journal,
    // No conversationSource: delegated and background children never had one.
    thread: taskThreadRecall({
      task,
      settings: getResolvedSettings(task.scope.workspaceRoot),
      allowed: () => allowed
    }),
    allowed: () => true,
    budgetTokens: () => 32_000,
    remainingTokens: () => 32_000,
    record: () => undefined
  })
  return { journal, tools }
}

describe('scoped specialist context handles (#151)', () => {
  it('lets each delegated specialist pull its assignment evidence from the parent thread', async () => {
    const parent = await parentTask()
    for (const [goal, query, expected] of [
      ['Check receipt totals', 'booking receipts currency', 'CAD'],
      ['Check reminder emails', 'booking times stored', 'UTC']
    ] as const) {
      const task = specialist(parent, goal, `child-${expected}`)
      expect(task.contextOrigin?.executionRoot).toBe(child)
      const { journal, tools } = pull(task)
      const found = await tools.search({ query, scope: 'thread' })
      expect(found.ok).toBe(true)
      expect(found.detail).toContain(expected)
      journal.close()
    }
  })

  it('never reaches another thread, even when asked for its words', async () => {
    const task = specialist(await parentTask(), 'Check receipts', 'child-1')
    const { journal, tools } = pull(task)
    const found = await tools.search({ query: 'payroll export password policy', scope: 'thread' })
    expect(found.detail).not.toContain('payroll')
    journal.close()
    // A task claiming a different thread cannot use the parent's seal.
    const moved = pull({ ...task, threadId: 'other' })
    expect((await moved.tools.search({ query: 'booking currency', scope: 'thread' })).ok).toBe(
      false
    )
    moved.journal.close()
  })

  it('is refused where the destination may not see the source conversation', async () => {
    const task = specialist(await parentTask(), 'Check receipts', 'child-1')
    const { journal, tools } = pull(task, false)
    const found = await tools.search({ query: 'booking receipts currency', scope: 'thread' })
    expect(found.ok).toBe(false)
    expect(found.detail).toMatch(
      /Conversation history was refused \(Source conversation disclosure/
    )
    expect(found.detail).not.toContain('CAD')
    journal.close()
  })

  it('stops working when the user changes the source controls after delegation', async () => {
    const task = specialist(await parentTask(), 'Check receipts', 'child-1')
    await saveMemoryControls(source, 't', { ...emptyMemoryControls(), forgotten: ['currency'] })
    const { journal, tools } = pull(task)
    const found = await tools.search({ query: 'booking receipts currency', scope: 'thread' })
    expect(found.detail).not.toContain('CAD')
    journal.close()
  })

  it('refuses a ref found before the controls changed, as a result and not a crash', async () => {
    const task = specialist(await parentTask(), 'Check receipts', 'child-1')
    const { journal, tools } = pull(task)
    const found = await tools.search({ query: 'booking receipts currency', scope: 'thread' })
    const ref = found.detail.match(/\[ref:([^ ]+)/)?.[1]
    expect(ref).toBeTruthy()
    await saveMemoryControls(source, 't', { ...emptyMemoryControls(), forgotten: ['currency'] })
    const read = await tools.read({ ref })
    expect(read).toMatchObject({ ok: false, mutated: false })
    expect(read.detail).toMatch(/Conversation history was refused/)
    expect(read.detail).not.toContain('CAD')
    journal.close()
  })

  it('grants evidence only: the child keeps its own, narrower authority', async () => {
    const parent = await parentTask()
    const task = specialist(parent, 'Check receipts', 'child-1')
    const authority = structuredClone(task.authority)
    pull(task).journal.close()
    expect(task.authority).toEqual(authority)
    expect(task.authority.edit).toBe(parent.authority.edit && task.authority.edit)
  })

  it('keeps a task without an origin or a conversation out of history', async () => {
    const task = createTaskContract({ workspacePath: child, text: 'Review', plan })
    expect(
      taskThreadRecall({ task, settings: getResolvedSettings(child), allowed: () => true })
    ).toBeUndefined()
  })
})
