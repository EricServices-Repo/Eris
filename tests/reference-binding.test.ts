import { resolveChatTurnContract } from '../electron/main/services/chat-turn'
import { taskContractConflicts } from '../src/shared/task-contract'
import { compactAgentMessages } from '../electron/main/services/agent/compaction'
import { reviewTaskOutcome } from '../electron/main/services/task-outcome'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { ChatDatabase } from '../electron/main/services/chat-database'
import { createTaskContract } from '../electron/main/services/task-intake'
import {
  recordRecommendationSource,
  recommendationSources
} from '../electron/main/services/recommendation-catalog'
import {
  bindTaskReferences,
  assertTaskReferences
} from '../electron/main/services/reference-binding'
import { extractRecommendations } from '../src/shared/recommendations'
import { getDefaults } from '../electron/main/services/settings'
import type { ChatMessage, TurnPlan } from '../src/shared/settings-schema'
import type { ResolvedReference } from '../electron/main/services/reference-binding'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import { compileTaskContext } from '../electron/main/services/agent/context-compiler'

const LOCAL = 'builtin:composer-lite'
const REMOTE = 'openai:gpt-test'
const a =
  '## Improvements\n1. Add authentication to src/auth.ts.\n2. Validate booking dates in src/book.ts.'
const b =
  '## Improvements\n1. Cache listing queries in src/search.ts.\n2. Paginate the listing results.'
let root: string, db: ChatDatabase
const settings = () => structuredClone(getDefaults())
const plan = (mode: 'agent' | 'ask' = 'agent'): TurnPlan =>
  ({
    intent: 'edit',
    mode,
    agentId: 'composer',
    agentName: 'Composer',
    toolPolicy: 'edit',
    models: { chat: LOCAL, tools: LOCAL }
  }) as TurnPlan
function source(taskId: string, answer: string, projectRoot = root): ChatMessage {
  const task = createTaskContract({
    taskId,
    threadId: 'thread',
    workspacePath: root,
    text: 'Review this project',
    plan: { ...plan(), intent: 'review' }
  })
  task.scope.projectRoot = projectRoot
  task.result = {
    terminal: 'complete',
    offeredRecommendations: extractRecommendations(answer),
    changedFiles: [],
    answerDigest: 'fixture'
  }
  recordRecommendationSource(task)
  return {
    id: `${taskId}:assistant`,
    role: 'assistant',
    content: answer,
    createdAt: 1,
    contextResult: { taskId, terminal: 'done', projectRoot, changedFiles: [] }
  }
}
const save = (messages: ChatMessage[]) =>
  db.save({ id: 'thread', title: 'History', model: LOCAL, createdAt: 1, updatedAt: 1, messages })
const bind = (text: string, overrides: Partial<Parameters<typeof bindTaskReferences>[0]> = {}) =>
  bindTaskReferences({
    root,
    threadId: 'thread',
    text,
    settings: settings(),
    models: [LOCAL],
    ...overrides
  })
const taskFor = (
  referenceBinding: ResolvedReference,
  text = 'Implement those improvements',
  mode: 'agent' | 'ask' = 'agent'
) =>
  createTaskContract({
    taskId: 'apply',
    threadId: 'thread',
    workspacePath: root,
    text,
    plan: plan(mode),
    referenceBinding
  })
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-reference-')))
  db = new ChatDatabase(join(root, '.db'))
  vi.mocked(workspaceRequest).mockImplementation(async (request) => {
    if (request.type !== 'context-reference-sources')
      throw new Error('Unexpected full-history request')
    return db.referenceSources(request.id, request.sources) as never
  })
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

it('binds an old exact ID before task intake without loading intervening history', async () => {
  save([
    source('old', a),
    ...Array.from({ length: 1000 }, (_, i): ChatMessage => ({
      id: `f${i}`,
      role: 'user',
      content: 'Unrelated message',
      createdAt: i + 2
    })),
    source('new', b)
  ])
  const wanted = extractRecommendations(a)[1]!
  const resolved = (await bind(`Implement recommendation ${wanted.id}`))!
  expect(resolved.binding.status).toBe('bound')
  const task = taskFor(resolved)
  expect(task.recommendations.map((item) => item.id)).toEqual([wanted.id])
  expect(task.authority.edit).toBe(true)
  expect(task.referenceBinding?.sources[0]?.messageId).toBe('old:assistant')
  expect(
    task.interpretation?.obligations.some((item) => item.id === `recommendation-${wanted.id}`)
  ).toBe(true)
  expect(
    vi
      .mocked(workspaceRequest)
      .mock.calls.every(([request]) => request.type === 'context-reference-sources')
  ).toBe(true)
})
it('requires clarification for an ambiguous ordinal and removes mutation authority', async () => {
  save([source('old', a), source('new', b)])
  const resolved = (await bind('Implement the second one'))!
  expect(resolved.binding.status).toBe('ambiguous')
  const task = taskFor(resolved, 'Implement the second one')
  expect(task.recommendations).toEqual([])
  expect(task.authority).toMatchObject({ tools: 'none', edit: false, execute: 'none' })
  expect(task.acceptanceCriteria.join(' ')).toContain('clarify')
})
it('keeps Ask mode read-only even for a bound implementation reference', async () => {
  save([source('old', a)])
  const resolved = (await bind(`Explain recommendation ${extractRecommendations(a)[0]!.id}`))!
  expect(taskFor(resolved, 'Explain the recommendation', 'ask').authority.edit).toBe(false)
})
it('does not widen an unknown explicit ID into the latest batch', async () => {
  save([source('new', b)])
  const result = (await bind('Implement recommendation 0000000000000000'))!
  expect(result.binding.status).toBe('unavailable')
  expect(taskFor(result).authority.edit).toBe(false)
})
it('rechecks forgotten sources before model dispatch and mutation admission', async () => {
  save([source('old', a)])
  const result = (await bind(`Implement ${extractRecommendations(a)[0]!.id}`))!
  const task = taskFor(result)
  await expect(assertTaskReferences(task, settings(), LOCAL)).resolves.toBeUndefined()
  db.contextControls('thread', {
    version: 1,
    forgotten: ['old:assistant'],
    pinned: [],
    afterOrdinal: 0
  })
  await expect(assertTaskReferences(task, settings(), LOCAL)).rejects.toThrow(/lost eligibility/)
  expect((await bind(`Implement ${extractRecommendations(a)[0]!.id}`))!.binding.status).toBe(
    'unavailable'
  )
})
it('rejects rewrites and deleted canonical threads', async () => {
  save([source('old', a)])
  const task = taskFor((await bind(`Implement ${extractRecommendations(a)[0]!.id}`))!)
  save([
    { id: 'old:assistant', role: 'assistant', content: 'No recommendation remains', createdAt: 1 }
  ])
  await expect(assertTaskReferences(task, settings(), LOCAL)).rejects.toThrow(/changed|eligibility/)
  db.remove('thread')
  await expect(assertTaskReferences(task, settings(), LOCAL)).rejects.toThrow(/changed|eligibility/)
})
it('retains source project scope and rejects references to multiple projects', async () => {
  const projectA = join(root, 'a'),
    projectB = join(root, 'b')
  mkdirSync(projectA)
  mkdirSync(projectB)
  save([source('old', a, projectA), source('new', b, projectB)])
  const id = extractRecommendations(a)[0]!.id
  expect(taskFor((await bind(`Implement ${id}`))!).scope.projectRoot).toBe(projectA)
  const mixed = (await bind(`Implement ${id} and ${extractRecommendations(b)[0]!.id}`))!
  expect(mixed.binding.status).toBe('ambiguous')
  expect(taskFor(mixed).authority.edit).toBe(false)
})
it('blocks remote older-history binding unless opted in, while preserving recent-source policy', async () => {
  save([source('old', a), source('new', b)])
  const text = `Implement ${extractRecommendations(a)[0]!.id}`
  expect((await bind(text, { models: [REMOTE] }))!.binding.status).toBe('unavailable')
  const recent = (await bind(text, { models: [REMOTE], recentSourceIds: ['old:assistant'] }))!
  expect(recent.binding).toMatchObject({ status: 'bound', remotePolicy: 'recent' })
  const shared = settings()
  shared.agent.contextMemory.shareWithRemoteModels = true
  expect((await bind(text, { models: [REMOTE], settings: shared }))!.binding.remotePolicy).toBe(
    'opt-in'
  )
})
it('blocks local-only references on a recovery model before any provider call', async () => {
  save([source('old', a)])
  const task = taskFor((await bind(`Implement ${extractRecommendations(a)[0]!.id}`))!)
  const compiled = compileTaskContext({
    task,
    guidance: '',
    project: '',
    retrieval: '',
    maxInputTokens: 8000
  })
  const stream = streamModelChat({
    settings: settings(),
    model: REMOTE,
    messages: [compiled.message, { role: 'user', content: 'Continue' }],
    temperature: 0,
    getSecret: () => null
  })
  await expect(stream.next()).rejects.toThrow(/destination may not receive/)
})
it('stores only bounded metadata for historical artifacts', () => {
  for (let i = 0; i < 70; i++) source(`review-${i}`, a)
  const sources = recommendationSources(root, 'thread')
  expect(sources).toHaveLength(64)
  expect(JSON.stringify(sources)).not.toContain('Add authentication')
})

it('does not send local-only historical references to a compaction or outcome model', async () => {
  save([source('old', a)])
  const task = taskFor((await bind(`Implement ${extractRecommendations(a)[0]!.id}`))!)
  const compiled = compileTaskContext({
    task,
    guidance: '',
    project: '',
    retrieval: '',
    maxInputTokens: 8000
  })
  const messages = [
    compiled.message,
    ...Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: 'Historical work ' + i
    }))
  ]
  const compacted = await compactAgentMessages({
    messages,
    goal: task.originalText,
    filesTouched: [],
    actionLog: [],
    treeSnapshot: null,
    priorMemory: null,
    settings: settings(),
    liteModel: REMOTE,
    temperature: 0,
    getSecret: () => null
  })
  expect(compacted.messages[0]?.contextBundle?.referenceTask).toBeDefined()
  const verdict = await reviewTaskOutcome({
    task,
    answer: 'Completed',
    evidence: [],
    settings: settings(),
    model: REMOTE,
    getSecret: () => null
  })
  expect(verdict.verdict).toBe('unresolved')
})
it('honors disabled recall instead of implicitly loading an older artifact', async () => {
  save([source('old', a)])
  const disabled = settings()
  disabled.agent.contextMemory.enabled = false
  expect(
    (await bind(`Implement ${extractRecommendations(a)[0]!.id}`, { settings: disabled }))!.binding
      .status
  ).toBe('unavailable')
})

it('uses the shared production turn boundary to bind references before constructing its task', async () => {
  save([source('old', a), source('new', b)])
  const id = extractRecommendations(a)[0]!.id
  const turn = await resolveChatTurnContract(
    {
      requestId: 'boundary',
      workspacePath: root,
      settings: settings(),
      text: `Implement ${id}`,
      model: LOCAL,
      threadId: 'thread',
      history: [],
      forceRoute: 'tools',
      getSecret: () => null
    },
    plan()
  )
  expect(turn.task.recommendations.map((item) => item.id)).toEqual([id])
  expect(turn.task.referenceBinding?.status).toBe('bound')
  expect(taskContractConflicts(turn.task)).toEqual([])
  const ambiguous = await resolveChatTurnContract(
    {
      requestId: 'ambiguous',
      workspacePath: root,
      settings: settings(),
      text: 'Implement the second one',
      model: LOCAL,
      threadId: 'thread',
      history: [],
      forceRoute: 'tools',
      getSecret: () => null
    },
    plan()
  )
  expect(ambiguous.task.authority.edit).toBe(false)
  expect(taskContractConflicts(ambiguous.task)).toEqual([])
})
it('rejects scope changes after binding instead of treating the reference as permission', async () => {
  save([source('old', a)])
  const task = taskFor((await bind(`Implement ${extractRecommendations(a)[0]!.id}`))!)
  task.scope.projectRoot = join(root, 'other')
  await expect(assertTaskReferences(task, settings(), LOCAL)).rejects.toThrow(/scope/)
})
