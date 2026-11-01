import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs'
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
import {
  rememberWorkspace,
  removeWorkspace,
  registeredWorkspaceId
} from '../electron/main/services/workspace'
import { getResolvedSettings } from '../electron/main/services/settings'
import { memoryKey, saveMemoryControls } from '../electron/main/services/context-memory'
import {
  createContextOrigin,
  bindContextOrigin,
  resolveContextOrigin
} from '../electron/main/services/context-origin'
import { originThreadRecall } from '../electron/main/services/agent/context-pull'
import { childTaskContract, createTaskContract } from '../electron/main/services/task-intake'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
let folder: string, source: string, target: string, priorProfile: string | undefined
const plan = {
  mode: 'agent',
  intent: 'review',
  toolPolicy: 'read',
  agentId: 'reviewer',
  models: { chat: 'local:test', tools: 'local:test' }
} as never
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'eris-origin-')))
  source = join(folder, 'source')
  target = join(folder, 'child')
  mkdirSync(source)
  mkdirSync(target)
  mkdirSync(join(source, 'app'))
  mkdirSync(join(target, 'app'))
  priorProfile = process.env.ERIS_TEST_APPDATA
  process.env.ERIS_TEST_APPDATA = join(folder, 'profile')
  rememberWorkspace(source)
  chatDatabase(workspaceChatsDir(source)).save({
    id: 't',
    title: 'Source',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'fact',
        role: 'user',
        content: 'Remember: booking receipt currency CAD',
        createdAt: 1,
        contextProjectRoot: join(source, 'app')
      }
    ]
  })
  vi.mocked(workspaceRequest).mockImplementation(
    async (req) => (await handleWorkspaceRequest(req as WorkspaceRequest)) as never
  )
})
afterEach(() => {
  closeChatDatabases()
  process.env.ERIS_TEST_APPDATA = priorProfile
  if (priorProfile === undefined) delete process.env.ERIS_TEST_APPDATA
  rmSync(folder, { recursive: true, force: true })
})
const origin = () =>
  createContextOrigin({
    sourceRoot: source,
    projectRoot: join(source, 'app'),
    threadId: 't',
    taskId: 'parent'
  })
const execution = () => ({
  root: target,
  projectRoot: join(target, 'app'),
  taskId: 'child',
  threadId: 't'
})
describe('host-sealed conversation origin (#263)', () => {
  it('resolves parent-only evidence from a separate execution worktree', async () => {
    const bound = bindContextOrigin((await origin())!, execution())
    expect(memoryKey(source, 't')).not.toBe(memoryKey(target, 't'))
    const resolved = await resolveContextOrigin(bound, execution())
    expect(resolved.root).toBe(source)
    expect(resolved.projectRoot).toBe(join(source, 'app'))
    const recall = originThreadRecall(bound, execution(), () => true)
    expect(
      (await recall.search('currency', 256)).items.some((item) => item.text.includes('CAD'))
    ).toBe(true)
    expect(bound.executionRoot).toBe(target)
  })
  it('rejects tampering, other-thread access and re-registration', async () => {
    const bound = bindContextOrigin((await origin())!, execution())
    await expect(
      resolveContextOrigin({ ...bound, threadId: 'other' }, execution())
    ).rejects.toThrow()
    await expect(
      resolveContextOrigin(bound, { ...execution(), threadId: 'other' })
    ).rejects.toThrow()
    removeWorkspace(registeredWorkspaceId(source)!)
    rememberWorkspace(source)
    await expect(resolveContextOrigin(bound, execution())).rejects.toThrow()
  })
  it('refuses cross-profile reuse and mismatched project mapping', async () => {
    const bound = bindContextOrigin((await origin())!, execution())
    expect(() => bindContextOrigin(bound, { ...execution(), projectRoot: target })).toThrow()
    process.env.ERIS_TEST_APPDATA = join(folder, 'other-profile')
    await expect(resolveContextOrigin(bound, execution())).rejects.toThrow()
  })
  it('invalidates the mapping on source controls changes and blocks disallowed disclosure', async () => {
    const bound = bindContextOrigin((await origin())!, execution())
    await expect(
      originThreadRecall(bound, execution(), () => false).search('currency', 256)
    ).rejects.toThrow('disclosure')
    await saveMemoryControls(source, 't', { ...emptyMemoryControls(), forgotten: ['fact'] })
    await expect(resolveContextOrigin(bound, execution())).rejects.toThrow('changed')
  })
  it.skipIf(process.platform === 'win32')(
    'canonicalizes source aliases and keeps nested child scope',
    async () => {
      const alias = join(folder, 'alias')
      symlinkSync(source, alias)
      const fromAlias = await createContextOrigin({
        sourceRoot: alias,
        projectRoot: join(alias, 'app'),
        threadId: 't',
        taskId: 'parent'
      })
      expect(fromAlias?.namespace).toBe(memoryKey(source, 't'))
      const parent = createTaskContract({
        workspacePath: source,
        text: 'Review this project',
        threadId: 't',
        taskId: 'parent',
        plan
      })
      parent.scope.projectRoot = join(source, 'app')
      parent.contextOrigin = fromAlias
      const child = childTaskContract(parent, plan, 'Review booking', target, 'child')
      expect(child.scope.workspaceRoot).toBe(target)
      expect(child.contextOrigin?.sourceRoot).toBe(source)
      expect((await resolveContextOrigin(child.contextOrigin!, execution())).root).toBe(source)
      expect(child.authority.edit).toBe(false)
    }
  )
  it('survives serialization while retaining current profile policy', async () => {
    const bound = JSON.parse(JSON.stringify(bindContextOrigin((await origin())!, execution())))
    expect((await resolveContextOrigin(bound, execution())).namespace).toBe(memoryKey(source, 't'))
    expect(getResolvedSettings(source).agent.contextMemory.shareWithRemoteModels).toBe(false)
  })
})
