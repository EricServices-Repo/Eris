import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Stage 5 of docs/reviews/eris-dev-10000-2026-10-23/AGENT-IMPROVEMENTS.md:
 * follow-ups, recommendations, top-level vs child agents, delegation outcomes
 * and recovery that keeps the task fixed (AG-052–058).
 */

import { extractRecommendations } from '../src/shared/recommendations'
import { createTaskContract, childTaskContract } from '../electron/main/services/task-intake'
import { completeChatTurnTask } from '../electron/main/services/chat-turn'
import { buildChatMessages } from '../electron/main/services/chat-prompt'
import { formatHandoffForPrompt } from '../src/shared/agent-orchestration'
import { TaskToolGateway } from '../electron/main/services/agent/tool-gateway'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'
import { decideMidRunAdapt } from '../electron/main/services/agent/mid-run-adapt'
import { compileTaskContext } from '../electron/main/services/agent/context-compiler'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import {
  markSimulatedSettings,
  runInDiagnosticsScope,
  SIMULATED_MODEL_REF,
  type ModelTransportRequest
} from '../electron/main/services/model-transport'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'eris-conversation-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const plan = (overrides: Partial<TurnPlan>): TurnPlan => ({
  intent: 'review',
  agentId: 'reviewer',
  agentName: 'Reviewer',
  mode: 'agent',
  models: { chat: SIMULATED_MODEL_REF, tools: SIMULATED_MODEL_REF },
  toolPolicy: 'read',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  ...overrides
})

describe('AG-053 recommendations as stable objects', () => {
  it.each([
    ['numbered', '1. Validate attempts in src/retry.ts.\n2. Enforce MAX_RETRIES.'],
    ['bulleted', 'Findings:\n- Validate attempts in src/retry.ts.\n* Enforce MAX_RETRIES.'],
    [
      'paragraph',
      'You should validate attempts in src/retry.ts.\n\nConsider enforcing MAX_RETRIES as well.'
    ]
  ])('extracts %s recommendations with targets', (_format, answer) => {
    const items = extractRecommendations(answer)
    expect(items).toHaveLength(2)
    expect(items[0]!.targets).toEqual(['src/retry.ts'])
    expect(extractRecommendations(answer).map((item) => item.id)).toEqual(
      items.map((item) => item.id)
    )
  })

  it('does not treat technology names or headings as recommendations', () => {
    const items = extractRecommendations('Summary:\n- Upgrade Next.js to the current release.')
    expect(items).toHaveLength(1)
    expect(items[0]!.targets).toBeUndefined()
  })
})

describe('AG-052 follow-ups resolve against the prior turn', () => {
  const review = 'Recommendations:\n- Validate attempts in src/retry.ts.\n- Enforce MAX_RETRIES.'

  it('applies recorded recommendations without parsing the prose again', () => {
    const root = workspace({ 'src/retry.ts': 'export const MAX_RETRIES = 3\n' })
    const first = completeChatTurnTask(
      createTaskContract({ workspacePath: root, text: 'Review src/retry.ts', plan: plan({}) }),
      { answer: review, changedFiles: [], terminal: 'complete' }
    )
    expect(first.result?.offeredRecommendations).toHaveLength(2)
    const follow = createTaskContract({
      workspacePath: root,
      text: 'Implement those recommendations',
      plan: plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit' }),
      priorTask: first,
      // The prose no longer has a list; the recorded objects still resolve.
      history: [{ role: 'assistant', content: 'See above.' }]
    })
    expect(follow.recommendations.map((item) => item.id)).toEqual(
      first.result!.offeredRecommendations.map((item) => item.id)
    )
    expect(follow.continuation).toMatchObject({
      priorTaskId: first.taskId,
      recommendationSource: 'prior-task'
    })
    expect(
      follow.interpretation?.obligations.filter((item) => item.id.startsWith('recommendation-'))
    ).toHaveLength(2)
    expect(follow.scope.projectRoot).toBe(first.scope.projectRoot)
  })

  it('falls back to the prior answer for threads saved before results existed', () => {
    const follow = createTaskContract({
      workspacePath: null,
      text: 'Apply those',
      plan: plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit' }),
      history: [{ role: 'assistant', content: review }]
    })
    expect(follow.recommendations).toHaveLength(2)
    expect(follow.continuation).toBeUndefined()
  })

  it('carries the files the prior turn changed for “what did you change?”', () => {
    const root = workspace({ 'src/retry.ts': 'x' })
    const edit = completeChatTurnTask(
      createTaskContract({
        workspacePath: root,
        text: 'Fix src/retry.ts',
        plan: plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit' })
      }),
      { answer: 'DONE', changedFiles: ['src/retry.ts'], terminal: 'complete' }
    )
    expect(edit.result?.offeredRecommendations).toEqual([])
    const ask = createTaskContract({
      workspacePath: root,
      text: 'What did you change?',
      plan: plan({ intent: 'explore', agentId: 'explainer' }),
      priorTask: edit
    })
    expect(ask.continuation?.changedFiles).toEqual(['src/retry.ts'])
    const { message } = compileTaskContext({
      task: ask,
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 8192
    })
    expect(message.content).toContain('"priorChangedFiles":["src/retry.ts"]')
  })
})

describe('AG-054 top-level and child roles', () => {
  it('addresses the top-level agent to the user and the child to its coordinator', () => {
    const [system] = buildChatMessages(null, getDefaults(), {
      text: 'Explain retries',
      mode: 'agent',
      agentId: 'planner',
      history: [],
      attachments: [],
      skillIds: []
    })
    expect(system!.content).toContain('answering the user directly')
    expect(system!.content).not.toMatch(/\bsubagent\b/)
    const handoff = formatHandoffForPrompt({
      parentGoal: 'Fix retries',
      goal: 'Inspect src/retry.ts',
      summary: 'Inspect',
      fromAgentId: 'composer',
      toAgentId: 'reviewer'
    })
    expect(handoff).toContain('not answering the user')
    const parent = createTaskContract({ workspacePath: null, text: 'x', plan: plan({}) })
    const facing = (task: typeof parent) =>
      JSON.parse(
        compileTaskContext({
          task,
          guidance: '',
          project: '',
          retrieval: '',
          maxInputTokens: 8192
        }).message.content.split('\n')[1]!
      )
    expect(facing(parent).assignment).toEqual({ kind: 'top-level', reportTo: 'user' })
  })
})

describe('AG-055 children never exceed the parent', () => {
  it('intersects authority and keeps the parent project', () => {
    const root = workspace({
      'apps/shop/package.json': '{"name":"shop"}',
      'apps/shop/src/cart.ts': 'export {}\n',
      'apps/blog/package.json': '{"name":"blog"}',
      'apps/blog/src/cart.ts': 'export {}\n'
    })
    const parent = createTaskContract({
      workspacePath: root,
      text: 'Review the shop app',
      plan: plan({})
    })
    expect(parent.scope.projectRoot).toBe(realpathSync(join(root, 'apps', 'shop')))
    const child = childTaskContract(
      parent,
      plan({ intent: 'edit', agentId: 'coder', toolPolicy: 'full' }),
      'Fix the cart',
      root,
      `${parent.taskId}:coder:1`
    )
    expect(child.authority).toMatchObject({ tools: 'read', edit: false, externalEffects: false })
    expect(child.deliverable).toBe('answer')
    expect(child.scope.projectRoot).toBe(parent.scope.projectRoot)
    expect(child.parentTaskId).toBe(parent.taskId)
    expect(child.result).toBeUndefined()

    const editingParent = createTaskContract({
      workspacePath: root,
      text: 'In the shop app, fix the cart',
      plan: plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit' })
    })
    const gateway = new TaskToolGateway(
      childTaskContract(
        editingParent,
        plan({ intent: 'edit', agentId: 'coder', toolPolicy: 'edit' }),
        'Fix cart',
        root,
        'child'
      )
    )
    expect(
      gateway.authorize(root, {
        name: 'write_file',
        args: { path: 'apps/blog/src/cart.ts', content: 'x' },
        raw: ''
      })
    ).toMatch(/belongs to another project/)
  })
})

describe('AG-056/AG-058 delegation outcomes and recovery in the loop', () => {
  async function runScripted(
    replies: Array<string | ((request: ModelTransportRequest) => string)>,
    turnPlan: TurnPlan,
    root: string,
    controller = new AbortController()
  ) {
    const events: Array<{ type: string; data: unknown; taskId: string }> = []
    const requests: ModelTransportRequest[] = []
    const output: Array<Record<string, unknown>> = []
    await runInDiagnosticsScope(
      {
        runId: 'conversation-test',
        mode: 'simulated',
        adapter: {
          kind: 'scripted',
          async *stream(request) {
            requests.push(request)
            const next = replies.shift()
            yield typeof next === 'function' ? next(request) : (next ?? 'DONE: nothing left to do.')
          }
        },
        onBlockedEffect: () => {},
        onTaskEvent: (event) =>
          events.push({ type: event.type, data: event.data, taskId: event.taskId })
      },
      async () => {
        try {
          for await (const event of runAgentWithWorkspaceTools({
            workspacePath: root,
            settings: markSimulatedSettings(structuredClone(getDefaults())),
            model: SIMULATED_MODEL_REF,
            messages: [
              { role: 'system', content: 'You are Eris.' },
              { role: 'user', content: 'Run the checks and review src/retry.ts' }
            ],
            temperature: 0,
            getSecret: () => null,
            mode: 'agent',
            turnPlan,
            mcp: 'off',
            jobId: 'chat:conversation-test',
            signal: controller.signal
          }))
            output.push(event as unknown as Record<string, unknown>)
        } catch (error) {
          output.push({ type: 'thrown', name: (error as Error).name })
        }
      }
    )
    const answer = output
      .filter((event) => event.type === 'answer')
      .reduce((text, event) => (event.replace ? String(event.text) : text + String(event.text)), '')
    return { events, requests, output, answer }
  }
  const runPlan = () =>
    plan({ intent: 'run', agentId: 'composer', agentName: 'Composer', toolPolicy: 'full' })
  const retry = { 'src/retry.ts': 'export const MAX_RETRIES = 3\n'.repeat(12) }
  const delegate = (goal: string) =>
    JSON.stringify({ name: 'delegate_to_agent', arguments: { agent_id: 'reviewer', goal } })
  const read = JSON.stringify({ name: 'read_file', arguments: { path: 'src/retry.ts' } })
  // delegate_to_agent is deferred; the coordinator discovers it as production models do.
  const discover = JSON.stringify({
    name: 'search_tools',
    arguments: { query: 'delegate to agent specialist' }
  })

  it('labels a child claim without evidence and reports it as unconfirmed', async () => {
    const { answer, events, requests } = await runScripted(
      [
        read,
        discover,
        delegate('Check whether retryDelay caps delays'),
        'retryDelay has no cap at all.',
        'DONE: the checks ran and the review of src/retry.ts is summarized above in detail.'
      ],
      runPlan(),
      workspace(retry)
    )
    const handoff = requests.find((request) =>
      request.messages.some((message) => String(message.content).includes('[Eris handoff'))
    )
    expect(handoff?.messages.map((message) => message.content).join('\n')).toContain(
      'not answering the user'
    )
    const delegation = events.find((event) => event.type === 'delegation')?.data as {
      status: string
    }
    // The requested read-only specialist, never an editor swapped in by routing.
    expect(delegation).toMatchObject({
      agentId: 'reviewer',
      childAuthority: { tools: 'read', edit: false }
    })
    // A claim the child never grounded is not adopted: it is unfinished or unverified.
    expect(['unverified', 'failed']).toContain(delegation.status)
    expect(answer).toContain('Specialist results not confirmed')
  })

  it('accepts a child that grounded its finding in the source', async () => {
    const { answer, events } = await runScripted(
      [
        read,
        discover,
        delegate('Review whether src/retry.ts enforces MAX_RETRIES'),
        read,
        'Findings for src/retry.ts: MAX_RETRIES is exported, but nothing in the file enforces it; callers can exceed the policy.',
        'DONE: the checks ran and the review of src/retry.ts is summarized above in detail.'
      ],
      runPlan(),
      workspace(retry)
    )
    expect(events.find((event) => event.type === 'delegation')?.data).toMatchObject({
      agentId: 'reviewer',
      status: 'done'
    })
    expect(answer).not.toContain('Specialist results not confirmed')
  })

  it('reports a child that returned nothing as unfinished', async () => {
    const { answer, events } = await runScripted(
      [
        read,
        discover,
        delegate('Inspect retry jitter'),
        '',
        'DONE: the checks ran and the review of src/retry.ts is summarized above in detail.'
      ],
      runPlan(),
      workspace(retry)
    )
    expect(events.find((event) => event.type === 'delegation')?.data).toMatchObject({
      status: 'failed'
    })
    expect(answer).toContain('did not finish')
  })

  it('propagates cancellation through a child', async () => {
    const controller = new AbortController()
    const { output, events } = await runScripted(
      [
        read,
        discover,
        delegate('Inspect retry jitter'),
        () => {
          controller.abort()
          return ''
        }
      ],
      runPlan(),
      workspace(retry),
      controller
    )
    expect(events.find((event) => event.type === 'delegation')?.data).toMatchObject({
      status: 'cancelled'
    })
    expect(output.some((event) => event.type === 'answer' && /DONE/.test(String(event.text)))).toBe(
      false
    )
  })

  it('keeps the task, artifact and authority when recovery changes worker', async () => {
    const missing = (path: string) => JSON.stringify({ name: 'read_file', arguments: { path } })
    const { events } = await runScripted(
      [missing('a.ts'), missing('b.ts'), missing('c.ts'), missing('d.ts')],
      plan({ intent: 'edit', agentId: 'composer', agentName: 'Composer', toolPolicy: 'edit' }),
      workspace(retry)
    )
    const reroute = events.find((event) => event.type === 'reroute')?.data as
      Record<string, unknown> | undefined
    const manifests = events.filter((event) => event.type === 'context-compiled')
    expect(reroute).toMatchObject({
      from: 'composer',
      to: 'coder',
      intent: 'edit',
      artifact: 'patch',
      authority: { edit: true },
      toolPolicy: 'edit',
      budget: { used: 1, max: 2 }
    })
    // The prompts before and after recovery compile the same task and revision.
    expect(manifests.length).toBeGreaterThanOrEqual(2)
    expect(new Set(manifests.map((event) => event.taskId))).toEqual(new Set([reroute!.taskId]))
    expect(
      new Set(manifests.map((event) => (event.data as { revision: number }).revision))
    ).toEqual(new Set([1]))
  })

  it('refuses a recovery worker that cannot edit an edit task', async () => {
    const root = workspace(retry)
    const task = createTaskContract({
      workspacePath: root,
      text: 'Fix src/retry.ts',
      plan: plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit' })
    })
    const decision = await decideMidRunAdapt({
      workspacePath: root,
      settings: getDefaults(),
      plan: plan({ intent: 'edit', agentId: 'reviewer', toolPolicy: 'read', task }),
      selectedModel: SIMULATED_MODEL_REF,
      goal: 'Fix src/retry.ts',
      getSecret: () => null,
      escalateCount: 0,
      rerouteCount: 0,
      actionLog: [],
      filesTouched: []
    })
    expect(decision).toMatchObject({ kind: null, refused: 'would-drop-edit-authority' })
  })
})

describe('AG-057 progress follows the named files', () => {
  it('does not count an unrelated edit toward a named-file fix', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'Fix safeDivide in src/divide.ts',
      plan: plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit' })
    })
    const workflow = new AgentWorkflow(
      plan({ intent: 'edit', agentId: 'composer', toolPolicy: 'edit', task }),
      task.originalText
    )
    workflow.noteTool({ ok: true, mutated: true, name: 'write_file', path: 'notes.md' })
    expect(
      workflow.evaluateOutcome({
        workspaceMutated: true,
        codeMutated: false,
        verifyPassed: false,
        filesTouched: ['notes.md']
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/src\/divide\.ts/) })
    expect(
      workflow.evaluateOutcome({
        workspaceMutated: true,
        codeMutated: false,
        verifyPassed: false,
        filesTouched: ['src/divide.ts']
      }).ok
    ).toBe(true)
  })
})
