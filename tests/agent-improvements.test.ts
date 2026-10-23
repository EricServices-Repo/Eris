import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Regression cases from docs/reviews/eris-dev-10000-2026-10-23/AGENT-IMPROVEMENTS.md.
 * Each block names the backlog item whose acceptance behavior it checks.
 */

const model = vi.hoisted(() => ({
  responses: [] as string[],
  requests: [] as Array<Record<string, unknown>>
}))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: Record<string, unknown>) {
    model.requests.push(options)
    yield model.responses.shift() ?? 'DONE: nothing left to do.'
  }
}))
vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => ({ ok: true, skipped: true, command: '', detail: '' })
}))
vi.mock('../electron/main/services/mcp-runtime', () => ({
  syncMcpRuntime: async () => undefined,
  listMcpTools: () => [],
  isMcpToolName: () => false,
  callMcpTool: async () => ({ ok: false, detail: 'no mcp' }),
  formatLiveMcpToolsPrompt: () => ''
}))
vi.mock('../electron/main/services/workspace-search', () => ({
  retrieveContextAsync: async () => ({ ok: true, paths: [], detail: '' }),
  workspaceGlob: () => ({ ok: true, detail: '' }),
  workspaceGrep: async () => ({ ok: true, detail: '' })
}))
vi.mock('../electron/main/services/code-index', () => ({
  findReferences: () => ({ ok: true, detail: '' }),
  findSymbols: () => ({ ok: true, detail: '' }),
  relatedFiles: () => ({ ok: true, detail: '' }),
  formatIndexSummary: () => ''
}))

import {
  asksForCodeExample,
  asksForVerification,
  chatAgentForTurn
} from '../src/shared/agent-contract'
import { isErisCapabilityQuestion, planChatTurn } from '../electron/main/services/chat-router'
import { conservativeFallback, resolveTaskIntent } from '../electron/main/services/task-resolver'
import { createTaskContract } from '../electron/main/services/task-intake'
import { taskContractConflicts } from '../src/shared/task-contract'
import { compileTaskContext } from '../electron/main/services/agent/context-compiler'
import { withoutSharedBlocks } from '../electron/main/services/agent/prompts'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'

const Q2 =
  'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?'
const Q6 =
  'Can you write per-user rate limiting so the happy path is obvious and errors are explicit?'
const Q7 = 'Can you write a clear Java version of generating image thumbnails on the fly?'
const Q34 =
  'Write a TypeScript implementation of cache invalidation after data changes that prioritizes clarity?'
const Q42 =
  'I need to implement transactional emails using templates with good test coverage. How would you approach it?'
const Q111 =
  'Show me an example of health checks that verify downstream dependencies inside a Django project?'
const Q524 =
  'Write a TypeScript implementation of seeding realistic test data that prioritizes clarity?'
const CAPABILITY_COLLISIONS = [
  'How would you design the data model and API for infinite scroll using cursor pagination?',
  'How would you design the data model and API for transactional emails using templates?',
  'How would you design the data model and API for role-based access control?'
]

beforeEach(() => {
  model.responses.length = 0
  model.requests.length = 0
})

const plan = (overrides: Partial<TurnPlan>): TurnPlan => ({
  intent: 'answer',
  agentId: 'explainer',
  agentName: 'Explainer',
  mode: 'agent',
  models: { chat: 'local:test', tools: 'local:test' },
  toolPolicy: 'none',
  requiresTools: false,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  ...overrides
})

async function routed(text: string, extra: Record<string, unknown> = {}) {
  return planChatTurn({
    workspacePath: null,
    settings: structuredClone(getDefaults()),
    getSecret: () => null,
    context: { text, selectedModel: 'local:test', mode: 'agent', skipModelRouter: true, ...extra }
  })
}

describe('AG-001/AG-002 answer plans and acceptance', () => {
  it.each([Q6, Q7, Q34])(
    'gives a tool-free answer no mutation or verification plan: %s',
    async (q) => {
      const turn = await routed(q)
      expect(turn.intent).toBe('answer')
      expect(turn.executionPlan?.steps.join(' ')).not.toMatch(/make the requested changes/i)
      expect(turn.executionPlan?.doneWhen).not.toMatch(/implemented|verification results/i)
      const task = createTaskContract({ workspacePath: null, text: q, plan: turn })
      expect(task.authority.edit).toBe(false)
      expect(task.acceptanceCriteria.join(' ')).not.toMatch(/implemented/i)
      expect(taskContractConflicts(task)).toEqual([])
    }
  )

  it('keeps an edit plan for an explicit edit', async () => {
    const turn = await routed('Fix the null check in src/app.ts')
    expect(turn.intent).toBe('edit')
    expect(turn.executionPlan?.steps).toContain('Make the requested changes')
  })

  it('turns an edit the authority cannot write into a described change', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'Fix the null check in src/app.ts',
      plan: plan({ intent: 'edit', toolPolicy: 'read', agentId: 'explainer' })
    })
    expect(task.deliverable).toBe('answer')
    expect(task.acceptanceCriteria[0]).toMatch(/without claiming it was applied/i)
    expect(taskContractConflicts(task)).toEqual([])
  })

  it('reports internally impossible contracts', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'Fix it',
      plan: plan({ intent: 'edit', toolPolicy: 'edit', agentId: 'composer' })
    })
    expect(
      taskContractConflicts({ ...task, authority: { ...task.authority, edit: false } })
    ).toContain('A patch deliverable requires edit authority.')
  })
})

describe('AG-005 complete examples are not replaced by plans', () => {
  it('falls back to an answer, not a plan, for a requested code example', () => {
    expect(asksForCodeExample(Q2)).toBe(true)
    expect(conservativeFallback(Q2, 'edit')).toBe('answer')
    expect(conservativeFallback('Could we make this easier to use?', 'edit')).toBe('plan')
    expect(conservativeFallback('Start the dev server', 'run')).toBe('explore')
  })

  it('applies the code-example fallback when the resolver cannot decide', async () => {
    model.responses.push('not json')
    expect(
      await resolveTaskIntent({
        text: Q2,
        fallback: 'edit',
        settings: getDefaults(),
        model: 'local:test',
        mode: 'agent',
        getSecret: () => null
      })
    ).toBe('answer')
  })

  it('keeps a named destination as a patch rather than a chat example', () => {
    expect(asksForCodeExample('Show a function that debounces input')).toBe(true)
    expect(asksForCodeExample('Add the debounce function to src/api.ts')).toBe(false)
    expect(asksForCodeExample('Write the middleware in this project')).toBe(false)
  })
})

describe('AG-006 verification is a requested action, not a feature noun', () => {
  it.each([
    Q42,
    Q111,
    Q524,
    "What's a good way to test cache invalidation after data changes without hitting real external services?"
  ])('does not treat %s as a verification request', (q) => {
    expect(asksForVerification(q)).toBe(false)
  })

  it.each([
    'Verify this implementation',
    'Check that the fix works',
    'Can you test the changes for regressions?',
    'Look for edge cases in the parser'
  ])('still recognizes %s', (q) => {
    expect(asksForVerification(q)).toBe(true)
  })

  it('routes the health-check and seed-data questions away from Verification', async () => {
    for (const q of [Q111, Q524]) expect((await routed(q)).intent).not.toBe('verify')
    expect((await routed('Verify this implementation')).intent).toBe('verify')
  })
})

describe('AG-007 application data models are not the Eris model catalog', () => {
  it.each(CAPABILITY_COLLISIONS)('keeps %s as application design', async (q) => {
    expect(isErisCapabilityQuestion(q)).toBe(false)
    expect((await routed(q)).intent).not.toBe('capability')
  })

  it.each([
    'Which models are installed in Eris?',
    'What models do you have access to?',
    'Which AI model are you using?',
    'Is the Ollama model connected?'
  ])('still answers %s from the catalog', (q) => {
    expect(isErisCapabilityQuestion(q)).toBe(true)
  })
})

describe('AG-008 code requests get an artifact-capable worker', () => {
  it('sends a short code request to Explainer instead of the three-sentence Fast role', () => {
    expect(chatAgentForTurn({ mode: 'agent', intent: 'answer', text: Q7 })).toBe('explainer')
    expect(chatAgentForTurn({ mode: 'agent', intent: 'answer', text: 'Is TCP reliable?' })).toBe(
      'fast'
    )
  })
})

describe('AG-016 resolved interpretation survives worker selection', () => {
  it('does not re-read verification keywords over a resolved intent', async () => {
    const turn = await routed('Verify this implementation', { resolvedIntent: 'explore' })
    expect(turn.intent).toBe('explore')
    expect(turn.agentId).not.toBe('verifier')
  })
})

describe('AG-023/AG-027 prompt protocol matches tools and authority', () => {
  const task = (intent: TurnPlan['intent'], toolPolicy: TurnPlan['toolPolicy']) =>
    createTaskContract({
      workspacePath: null,
      text: 'x',
      plan: plan({ intent, toolPolicy, agentId: intent === 'edit' ? 'composer' : 'planner' })
    })

  it('compiles a tool-free contract for answers', () => {
    const { message } = compileTaskContext({
      task: task('answer', 'none'),
      toolsAvailable: false,
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 8192
    })
    expect(message.content).toContain('TASK CONTRACT')
    expect(message.content).toContain('No tools are available')
    expect(message.content).not.toMatch(/<<<TOOL>>>|write_file|read_file/)
  })

  it('omits write examples and create-files directives for read-only roles', () => {
    const readOnly = compileTaskContext({
      task: task('plan', 'read'),
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 8192
    }).message.content
    expect(readOnly).not.toMatch(/write_file|search_replace|create the requested application files/)
    expect(readOnly).toContain('read-only')
    const edit = compileTaskContext({
      task: task('edit', 'edit'),
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 8192
    }).message.content
    expect(edit).toContain('search_replace')
  })
})

describe('AG-025 shared rules appear once in worker prompts', () => {
  it('drops the chat prompt copy of the shared rules', () => {
    const settings = getDefaults()
    const prior = `AGENT CONTRACT — Plan\n\n${settings.agent.systemPrompt.slice(0, 2000)}\n\nYou are the Plan subagent.`
    const out = withoutSharedBlocks(prior, null, settings)
    expect(out).not.toContain('Shared rules (every role inherits these)')
    expect(out).toContain('You are the Plan subagent.')
  })
})

const LOOP_MODELS = { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' }

describe('agent loop request contents', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'eris-improve-'))
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  const drain = async (gen: AsyncGenerator<unknown>) => {
    const events: Array<Record<string, unknown>> = []
    for await (const event of gen) events.push(event as Record<string, unknown>)
    return events
  }
  const run = (turnPlan: TurnPlan, text: string, settings = getDefaults()) =>
    drain(
      runAgentWithWorkspaceTools({
        workspacePath: ws,
        settings,
        model: LOOP_MODELS.chat,
        messages: [
          { role: 'system', content: settings.agent.systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan,
        mcp: 'off'
      })
    )

  it('AG-023: answer-only prompts carry the task contract and no edit plan', async () => {
    model.responses.push('Here is the example.')
    const turn = await routed(Q6)
    // The routed model is a placeholder; run the routed plan on the test transport.
    await run({ ...turn, error: undefined, models: LOOP_MODELS }, Q6)
    const system = String(
      (model.requests.at(-1)?.messages as Array<{ role: string; content: string }>)[0]?.content
    )
    expect(system).toContain('TASK CONTRACT')
    expect(system).toContain('No tools are available')
    expect(system).not.toMatch(/Make the requested changes|Routing:/)
  })

  it('AG-036/AG-037/AG-039: edit tools match runtime availability and verification authority', async () => {
    model.responses.push('DONE: nothing to change.')
    await run(
      plan({
        intent: 'edit',
        agentId: 'composer',
        agentName: 'Composer',
        toolPolicy: 'edit',
        requiresTools: true,
        models: LOOP_MODELS
      }),
      'Fix the null check in index.ts'
    )
    const names = model.requests
      .flatMap((request) => (request.tools as Array<{ function: { name: string } }>) ?? [])
      .map((tool) => tool.function.name)
    const prompt = JSON.stringify(model.requests.map((request) => request.messages))
    expect(names).toContain('write_file')
    expect(names).not.toContain('generate_image')
    expect(names).not.toContain('search_mcp_tools')
    expect(names).toContain('run')
    expect(prompt).toContain('TASK CONTRACT')
  })
})
