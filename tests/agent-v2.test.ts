import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createTaskContract,
  childTaskContract,
  projectRegistry
} from '../electron/main/services/task-intake'
import { executeTool } from '../electron/main/services/agent/execute-tool'
import { TaskToolGateway } from '../electron/main/services/agent/tool-gateway'
import { acquireProjectWrite } from '../electron/main/services/agent/task-scheduler'
import {
  compileModelMessages,
  validateModelTranscript,
  budgetModelMessages,
  type ModelMessage
} from '../electron/main/services/model-protocol'
import { compileTaskContext } from '../electron/main/services/agent/context-compiler'
import { compactWorkerMessagesForSession } from '../electron/main/services/agent-sessions'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'
import { parseToolCalls } from '../electron/main/services/agent/tool-parsing'
import { streamOpenAICompatible } from '../electron/main/services/openai-compatible'
import { getDefaults } from '../electron/main/services/settings'
import { buildPreservedWorkerMessages } from '../electron/main/services/agent/prompts'
import { contextBudgetTokens } from '../electron/main/services/agent/context-budget'
import { COMPOSER_OPENAI_TOOLS, getToolContract } from '../electron/main/services/tool-registry'
import type { TurnPlan } from '../src/shared/settings-schema'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'eris-v2-'))
  roots.push(root)
  return root
}
const plan: TurnPlan = {
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  toolPolicy: 'edit',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  models: { chat: 'local:test', tools: 'local:test' }
}
const exchange: ModelMessage[] = [
  { role: 'system', content: 'Pinned task' },
  { role: 'user', content: 'Read the file' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' }
      }
    ]
  },
  { role: 'tool', tool_call_id: 'call-1', content: 'source evidence' }
]

describe('agent v2 task boundary', () => {
  it.each([
    'Review the website build',
    'Review the app',
    'Inspect the project',
    'Review my website'
  ])('binds a generic project reference to the current workspace: %s', (text) => {
    const root = fixture()
    const task = createTaskContract({ workspacePath: root, text, plan })
    expect(task.scope).toMatchObject({ state: 'resolved', projectRoot: realpathSync(root) })
  })

  it('finds nested projects by package metadata and binds implementation follow-ups to that scope', () => {
    const root = fixture()
    const project = join(root, 'clients', 'web')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'composer.json'), JSON.stringify({ name: 'client/airbnb' }))
    const review = createTaskContract({
      workspacePath: root,
      text: 'Review the Airbnb website',
      plan: { ...plan, intent: 'review', toolPolicy: 'read' }
    })
    expect(review.scope.projectRoot).toBe(realpathSync(project))
    const edit = createTaskContract({
      workspacePath: root,
      text: 'Implement those improvements',
      plan,
      priorTask: review,
      history: [
        { role: 'assistant', content: '1. Add search in index.php\n2. Fix booking in book.php' }
      ]
    })
    expect(edit.scope.projectRoot).toBe(realpathSync(project))
    expect(edit.recommendations).toHaveLength(2)
    expect(new Set(edit.recommendations.map((item) => item.id)).size).toBe(2)
  })
  it('does not select one of two matching projects or follow symbolic directory trees', () => {
    const root = fixture()
    mkdirSync(join(root, 'airbnb-one'))
    mkdirSync(join(root, 'airbnb-two'))
    expect(
      createTaskContract({ workspacePath: root, text: 'Review the Airbnb website', plan }).scope
        .state
    ).toBe('ambiguous')
    expect(projectRegistry(root).length).toBeGreaterThan(1)
  })
  it('intersects specialist authority while allowing a review assignment inside an edit task', () => {
    const root = fixture()
    const parent = createTaskContract({ workspacePath: root, text: 'Fix booking', plan })
    const reviewer = childTaskContract(
      parent,
      { ...plan, intent: 'review', toolPolicy: 'read' },
      'Review booking',
      root,
      'child'
    )
    expect(reviewer.deliverable).toBe('review')
    expect(reviewer.authority.edit).toBe(false)
    const writer = childTaskContract(
      reviewer,
      { ...plan, toolPolicy: 'full' },
      'Write code',
      root,
      'grandchild'
    )
    expect(writer.authority.tools).toBe('read')
    expect(writer.authority.externalEffects).toBe(false)
  })
  it('blocks unrelated projects and edits based on stale inspected content', () => {
    const root = fixture()
    mkdirSync(join(root, 'airbnb'))
    mkdirSync(join(root, 'calculator'))
    writeFileSync(join(root, 'airbnb', 'index.php'), 'old')
    const task = createTaskContract({
      workspacePath: root,
      text: 'Fix code for the Airbnb website',
      plan
    })
    const gateway = new TaskToolGateway(task)
    expect(
      gateway.authorize(root, { name: 'write_file', args: { path: 'calculator/App.js' }, raw: '' })
    ).toContain('another project')
    gateway.rememberRead('airbnb/index.php')
    writeFileSync(join(root, 'airbnb/index.php'), 'concurrent change')
    expect(
      gateway.authorize(root, { name: 'write_file', args: { path: 'airbnb/index.php' }, raw: '' })
    ).toContain('changed after inspection')
  })
  it('reads a bounded source range and prevents a whole-file rewrite based on that excerpt', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'large.ts'),
      Array.from(
        { length: 2000 },
        (_, index) => `export const value${index + 1} = ${index + 1}`
      ).join('\n')
    )
    const task = createTaskContract({ workspacePath: root, text: 'Fix a source line', plan })
    const gateway = new TaskToolGateway(task)
    const call = {
      name: 'read_file',
      args: { path: 'large.ts', start_line: 1500, end_line: 1501 },
      raw: ''
    }
    const result = executeTool(root, call)
    expect(result.detail).toContain('value1500')
    expect(result.detail).not.toContain('value1499')
    gateway.record('source-range', call, result)
    expect(
      gateway.authorize(root, {
        name: 'write_file',
        args: { path: 'large.ts', content: 'replacement' },
        raw: ''
      })
    ).toContain('partially inspected')
    expect(
      gateway.authorize(root, { name: 'search_replace', args: { path: 'large.ts' }, raw: '' })
    ).toBeNull()
  })
  it.each(['generic', 'unverified'] as const)(
    'does not require workspace activity for %s advice',
    (applicability) => {
      const readPlan: TurnPlan = {
        ...plan,
        intent: 'plan',
        toolPolicy: 'read',
        requiresTools: true
      }
      const task = createTaskContract({
        workspacePath: fixture(),
        text: 'Give me an approach to connection pooling.',
        plan: readPlan
      })
      task.scope.applicability = applicability
      const workflow = new AgentWorkflow({ ...readPlan, task })
      expect(workflow.contract.requiresWorkspaceEvidence).toBe(false)
      expect(
        workflow.evaluateOutcome({
          workspaceMutated: false,
          codeMutated: false,
          verifyPassed: false
        }).ok
      ).toBe(true)
    }
  )

  it('does not count a directory listing as review evidence', () => {
    const workflow = new AgentWorkflow({ ...plan, intent: 'review', toolPolicy: 'read' })
    workflow.noteTool({ name: 'tree', path: '.', ok: true, mutated: false })
    expect(
      workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false })
        .ok
    ).toBe(false)
    workflow.noteTool({ name: 'read_file', path: 'src/App.tsx', ok: true, mutated: false })
    expect(
      workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false })
        .ok
    ).toBe(true)
  })
})

describe('agent v2 model boundary', () => {
  it('preserves native IDs and serializes complete exchanges for a local text template', () => {
    expect(
      compileModelMessages(exchange, {
        protocol: 'native-tools',
        contextWindow: 8192,
        outputReserve: 1000
      })
    ).toEqual(exchange)
    const local = compileModelMessages(exchange, {
      protocol: 'text-tools',
      contextWindow: 8192,
      outputReserve: 1000
    })
    expect(local[2]!.content).toContain('read_file')
    expect(local[3]!.content).toContain('TOOL_RESULT call-1')
    expect(local[3]!.content).toContain('source evidence')
  })
  it('rejects orphan, duplicate, and incomplete call/result exchanges', () => {
    expect(() => validateModelTranscript(exchange.slice(0, -1))).toThrow('unresolved')
    expect(() => validateModelTranscript([exchange[3]!])).toThrow('Orphan')
    expect(() => validateModelTranscript([...exchange, exchange[3]!])).toThrow('Orphan')
  })
  it('preserves task authority and complete exchanges through session trimming', () => {
    const compacted = compactWorkerMessagesForSession(
      [...exchange, { role: 'assistant', content: 'Done' }],
      200
    )
    expect(compacted.some((message) => message.content === 'Pinned task')).toBe(true)
    expect(() => validateModelTranscript(compacted)).not.toThrow()
  })
  it('keeps mandatory contract blocks or fails explicitly when they cannot fit', () => {
    const root = fixture()
    const task = createTaskContract({ workspacePath: root, text: 'Fix booking', plan })
    const result = compileTaskContext({
      task,
      guidance: 'Read then edit',
      project: 'x'.repeat(20000),
      retrieval: '',
      maxInputTokens: 2000
    })
    expect(result.message.content).toContain(task.taskId)
    expect(result.message.content.length).toBeLessThanOrEqual(3300)
    expect(() =>
      budgetModelMessages([{ role: 'system', content: 'x'.repeat(10000) }], 100)
    ).toThrow('exceed')
  })
  it('fits a default local task and core tool definitions into an 8k model window', async () => {
    const root = fixture()
    const settings = structuredClone(getDefaults())
    settings.models.contextWindow = 8192
    const tools = COMPOSER_OPENAI_TOOLS.filter(
      (tool) => getToolContract(tool.function.name)?.discovery === 'core'
    )
    const available =
      contextBudgetTokens(settings, 'local:test') -
      Math.ceil(JSON.stringify(tools).length / 3) -
      128
    const task = createTaskContract({ workspacePath: root, text: 'Fix booking', plan })
    const messages = await buildPreservedWorkerMessages({
      messages: [{ role: 'user', content: 'Fix booking' }],
      workspacePath: root,
      settings,
      plan: { ...plan, task },
      originalUserGoal: 'Fix booking',
      retrievalHint: '',
      mcpToolCount: 0,
      inputTokenBudget: available
    })
    expect(() =>
      budgetModelMessages(
        [
          ...messages,
          { role: 'system', content: JSON.stringify(tools.map((tool) => tool.function)) }
        ],
        contextBudgetTokens(settings, 'local:test')
      )
    ).not.toThrow()
  })
  it('does not execute tool-shaped JSON inside explanatory prose', () => {
    expect(
      parseToolCalls(
        'For example, use {"name":"write_file","path":"App.js","content":"bad"} in your code.'
      )
    ).toHaveLength(0)
    expect(parseToolCalls('{"name":"read_file","path":"App.js"}')).toHaveLength(1)
  })
  it('rejects native tool calls from a truncated stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write_file","arguments":"{}"}}]}}]}\n\n',
            { status: 200 }
          )
      )
    )
    const calls = vi.fn()
    await expect(
      (async () => {
        for await (const _chunk of streamOpenAICompatible({
          baseUrl: 'http://test.invalid',
          model: 'test',
          messages: [],
          temperature: 0,
          onNativeToolCalls: calls
        })) {
          /* drain */
        }
      })()
    ).rejects.toThrow('Incomplete')
    expect(calls).not.toHaveBeenCalled()
  })
})

it('serializes project mutations and removes cancelled waiters', async () => {
  const release = await acquireProjectWrite('project')
  const abort = new AbortController()
  const waiting = acquireProjectWrite('project', abort.signal)
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await rejected
  let entered = false
  const next = acquireProjectWrite('project').then((unlock) => {
    entered = true
    unlock()
  })
  await Promise.resolve()
  expect(entered).toBe(false)
  release()
  await next
  expect(entered).toBe(true)
})
