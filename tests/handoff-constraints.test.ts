import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  root: '',
  runs: [] as Array<{ messages: Array<{ role: string; content: string }>; task: unknown }>
}))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('../electron/main/services/chat-router', () => ({
  planChatTurn: async () => ({
    mode: 'agent',
    agentId: 'reviewer',
    agentName: 'Reviewer',
    intent: 'review',
    reason: 'test',
    toolPolicy: 'read',
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
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: async function* (options: {
    messages: (typeof h.runs)[number]['messages']
    turnPlan: { task: unknown }
  }) {
    h.runs.push({ messages: options.messages, task: options.turnPlan.task })
    yield { type: 'answer', text: 'ok' }
  }
}))

import { delegateFromAgent, getBackgroundJob } from '../electron/main/services/background-agents'
import {
  compileTaskContext,
  modelFacingTask
} from '../electron/main/services/agent/context-compiler'
import { childTaskContract, createTaskContract } from '../electron/main/services/task-intake'
import {
  MAX_HANDOFF_CONSTRAINT_CHARS,
  formatHandoffBriefing,
  formatHandoffForPrompt,
  handoffConstraintProblem,
  handoffMessages,
  type AgentHandoffPacket
} from '../src/shared/agent-orchestration'
import type { TaskContract } from '../src/shared/task-contract'

h.root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-handoff-')))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => {
  h.runs.length = 0
})

const REQUIRED = 'REQUIRED-CURRENCY-GBP'
const plan = (intent = 'review', toolPolicy = 'read') =>
  ({
    mode: 'agent',
    intent,
    toolPolicy,
    agentId: 'reviewer',
    agentName: 'Reviewer',
    models: { chat: 'local:t', tools: 'local:t' }
  }) as never
const parent = () =>
  createTaskContract({
    workspacePath: h.root,
    text: 'Implement booking',
    plan: plan('edit', 'edit')
  })
const child = (from: TaskContract, constraints: string[] = [REQUIRED], id = 'child') =>
  childTaskContract(from, plan(), 'Check the validator', h.root, id, constraints)
const packet = (extra: Partial<AgentHandoffPacket> = {}): AgentHandoffPacket => ({
  task: parent(),
  parentGoal: 'Implement booking',
  goal: 'Check the validator',
  summary: 'Looked at the form',
  constraints: [REQUIRED],
  fromAgentId: 'composer',
  toAgentId: 'reviewer',
  ...extra
})
const crowded = `${'x '.repeat(95_000)}\nTAIL-OF-BRIEFING`
const compile = (task: TaskContract, project: string, maxInputTokens: number) =>
  compileTaskContext({ task, guidance: 'g', project, retrieval: '', maxInputTokens })

describe('required handoff constraints', () => {
  it('reproduces the loss when a constraint lives only in the briefing', () => {
    const { message } = compile(child(parent(), []), `${crowded}\n${REQUIRED}`, 4_000)
    expect(String(message.content)).not.toContain(REQUIRED)
  })

  it('reaches the child under a crowded but valid budget', () => {
    const { message, blocks } = compile(child(parent()), crowded, 4_000)
    expect(String(message.content)).toContain(REQUIRED)
    expect(String(message.content)).not.toContain('TAIL-OF-BRIEFING')
    expect(blocks.find((block) => block.kind === 'project')).toMatchObject({ status: 'truncated' })
    expect(blocks.find((block) => block.kind === 'task')).toMatchObject({ status: 'included' })
  })

  it('blocks the run before inference when they cannot fit', () => {
    const many = Array.from({ length: 12 }, (_, i) => `${i} ${'y'.repeat(280)}`)
    expect(() => compile(child(parent(), many), '', 600)).toThrow('exceed this model context')
  })

  it('keeps task and tool authority when optional evidence goes', () => {
    const facing = modelFacingTask(child(parent()))
    expect(facing.authority).toMatchObject({ tools: 'read', edit: false })
    expect(String(compile(child(parent()), crowded, 4_000).message.content)).toContain(
      '"authority"'
    )
  })

  it('records what was omitted without logging the text', () => {
    const { blocks } = compile(child(parent()), `${crowded}\nPRIVATE-PROSE`, 4_000)
    const manifest = JSON.stringify(blocks)
    expect(manifest).not.toContain('PRIVATE-PROSE')
    const project = blocks.find((block) => block.kind === 'project')!
    expect(project.omittedChars).toBeGreaterThan(0)
    expect(project.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('carries constraints down a chain of children', () => {
    const leaf = child(child(parent(), [REQUIRED], 'a'), ['ALSO-THIS'], 'b')
    expect(leaf.inherited?.constraints).toEqual([REQUIRED, 'ALSO-THIS'])
  })

  it('refuses too many rather than dropping the ones past the limit', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `rule ${i}`)
    expect(() => child(child(parent(), twelve, 'a'), ['one more'], 'b')).toThrow(/at most 12/)
  })

  it('refuses one that is too long rather than shortening it', () => {
    const long = 'z'.repeat(MAX_HANDOFF_CONSTRAINT_CHARS + 1)
    expect(handoffConstraintProblem([long])).toContain('at most 300 characters')
    expect(handoffConstraintProblem(['short'])).toBeNull()
  })
})

describe('handoff serialization', () => {
  it('keeps the goal and constraints out of the briefing', () => {
    const briefing = formatHandoffBriefing(packet())
    expect(briefing).not.toContain(REQUIRED)
    expect(briefing).not.toContain('Check the validator')
    expect(briefing).not.toContain('Parent request:')
    expect(briefing).toContain('Looked at the form')
    expect(briefing).toContain('not answering the user')
  })

  it('still shows constraints wherever the whole packet is displayed', () => {
    expect(formatHandoffForPrompt(packet())).toContain(REQUIRED)
  })

  it('gives a background job the same messages and contract as an inline one', async () => {
    const handoff = packet()
    const job = delegateFromAgent({
      workspacePath: h.root,
      model: 'local:t',
      agentId: 'reviewer',
      goal: handoff.goal,
      summary: handoff.summary,
      handoff
    })
    await vi.waitFor(
      () => {
        expect(h.runs).toHaveLength(1)
        expect(getBackgroundJob(job.id)?.status).not.toBe('running')
      },
      { timeout: 2_000 }
    )
    expect(h.runs[0]!.messages).toEqual(handoffMessages(handoff))
    expect(h.runs[0]!.messages.filter((item) => item.role === 'user')).toEqual([
      { role: 'user', content: handoff.goal }
    ])
    const contract = h.runs[0]!.task as TaskContract
    expect(contract.inherited?.constraints).toEqual([REQUIRED])
  })
})
