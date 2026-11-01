import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  root: '',
  runs: [] as Array<{ messages: Array<{ role: string; content: string }> }>
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
  addAgentWorktree: vi.fn(async (_root: string, id: string) => ({
    path: `/worktrees/${id}`,
    branch: `branch-${id}`,
    destinationBranch: 'main',
    baseSha: 'a'
  })),
  diffWorktree: vi.fn(),
  mergeAgentBranch: vi.fn(),
  removeAgentWorktree: vi.fn()
}))
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: async function* (options: (typeof h.runs)[number]) {
    h.runs.push(options)
    yield* []
  }
}))

import { conflictingAliases } from '../electron/main/services/agent/tool-parsing'
import { createTaskContract } from '../electron/main/services/task-intake'
import {
  HANDOFF_LIMITS,
  HANDOFF_VERSION,
  formatHandoffBriefing,
  handoffMessages,
  parseHandoff,
  type AgentHandoffPacket
} from '../src/shared/agent-orchestration'

h.root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-envelope-')))
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => {
  h.runs.length = 0
})

const task = () =>
  createTaskContract({
    workspacePath: h.root,
    text: 'Implement booking',
    plan: {
      mode: 'agent',
      intent: 'edit',
      toolPolicy: 'edit',
      agentId: 'coder',
      agentName: 'Coder',
      models: { chat: 'local:t', tools: 'local:t' }
    } as never
  })
const packet = (extra: Record<string, unknown> = {}) => ({
  goal: 'Check the validator',
  summary: 'Looked at the form',
  fromAgentId: 'coder',
  toAgentId: 'reviewer',
  ...extra
})
const parsed = (extra: Record<string, unknown> = {}) => {
  const result = parseHandoff(packet(extra))
  if (!result.ok) throw new Error(result.error)
  return result.packet
}
const refused = (extra: Record<string, unknown>) => {
  const result = parseHandoff(packet(extra))
  if (result.ok) throw new Error('Expected a refusal')
  return result.error
}

describe('parseHandoff', () => {
  it('stamps the version and keeps a valid packet as it was', () => {
    expect(parsed({ files: ['src/a.ts'], confidence: 0.5 })).toEqual({
      ...packet({ files: ['src/a.ts'], confidence: 0.5 }),
      version: HANDOFF_VERSION
    })
  })

  it('refuses a missing, blank or oversized goal, saying what to do', () => {
    expect(refused({ goal: '   ' })).toMatch(/requires a goal/)
    expect(refused({ goal: undefined })).toMatch(/requires a goal/)
    expect(refused({ goal: 'g'.repeat(HANDOFF_LIMITS.goalChars + 1) })).toMatch(
      /at most .* summary/
    )
  })

  it.each([-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5'])(
    'refuses confidence %s',
    (confidence) => expect(refused({ confidence })).toMatch(/from 0 to 1/)
  )

  it('accepts the ends of the confidence range', () => {
    expect(parsed({ confidence: 0 }).confidence).toBe(0)
    expect(parsed({ confidence: 1 }).confidence).toBe(1)
  })

  it('refuses constraints it cannot guarantee instead of dropping them', () => {
    expect(
      refused({
        constraints: Array(13)
          .fill(0)
          .map((_, i) => `c${i}`)
      })
    ).toMatch(/at most 12/)
    expect(refused({ constraints: ['c'.repeat(301)] })).toMatch(/at most 300/)
    expect(refused({ constraints: [1] })).toMatch(/list of strings/)
  })

  it('refuses a malformed list or agent id', () => {
    expect(refused({ files: 'src/a.ts' })).toMatch(/list of strings/)
    expect(refused({ openQuestions: [{}] })).toMatch(/list of strings/)
    expect(refused({ toAgentId: '' })).toMatch(/toAgentId/)
    expect(refused({ fromAgentId: 'x'.repeat(200) })).toMatch(/fromAgentId/)
    expect(parseHandoff(null)).toMatchObject({ ok: false })
  })

  it('cuts an oversized summary and says so, in the packet and the briefing', () => {
    const value = parsed({ summary: 's'.repeat(HANDOFF_LIMITS.textChars * 3) })
    expect(value.summary.length).toBeLessThanOrEqual(HANDOFF_LIMITS.textChars)
    expect(value.summary).toMatch(/Shortened at the handoff limit/)
    expect(value.truncated).toEqual(['summary'])
    expect(formatHandoffBriefing(value)).toMatch(/Incomplete: summary/)
  })

  it('falls back to the goal for an empty summary', () => {
    expect(parsed({ summary: '  ' }).summary).toBe('Check the validator')
  })

  it('bounds and deduplicates file leads and open questions, and records it', () => {
    const value = parsed({
      files: ['a.ts', 'a.ts', ...Array.from({ length: 100 }, (_, i) => `f${i}.ts`)],
      openQuestions: [
        'q?',
        'q?',
        'x'.repeat(2000),
        ...Array(30)
          .fill(0)
          .map((_, i) => `q${i}`)
      ]
    })
    expect(value.files).toHaveLength(HANDOFF_LIMITS.files)
    expect(new Set(value.files).size).toBe(HANDOFF_LIMITS.files)
    expect(value.openQuestions).toHaveLength(HANDOFF_LIMITS.openQuestions)
    expect(value.openQuestions).not.toContain('x'.repeat(2000))
    expect(value.truncated).toEqual(expect.arrayContaining(['files', 'openQuestions']))
  })

  it('does not record a cut for plain duplicates', () => {
    expect(parsed({ files: ['a.ts', 'a.ts'] })).not.toHaveProperty('truncated')
  })

  it.each(['/etc/passwd', '../secret', 'src/../../x', 'C:/Windows', '~/.ssh/id', 'a\u0000b'])(
    'treats %j as outside what a file lead may name',
    (file) => {
      const value = parsed({ files: [file, 'ok.ts'] })
      expect(value.files).toEqual(['ok.ts'])
      expect(value.truncated).toEqual(['files'])
    }
  )

  it('makes a path inside the project relative', () => {
    const contract = task()
    const inside = `${contract.scope.projectRoot}/src/a.ts`
    expect(parsed({ task: contract, files: [inside] }).files).toEqual(['src/a.ts'])
  })

  it('never saves a field or live value it does not know', () => {
    const contract = task()
    const value = parsed({
      apiKey: 'sk-secret',
      threadHandle: { id: 't' },
      ramStore: new Map([['k', 'PRIVATE']]),
      task: { ...contract, apiKey: 'sk-secret', leak: () => 'PRIVATE' }
    })
    const saved = JSON.stringify(value)
    expect(saved).not.toContain('sk-secret')
    expect(saved).not.toContain('PRIVATE')
    expect(Object.keys(value).sort()).toEqual(
      ['fromAgentId', 'goal', 'summary', 'task', 'toAgentId', 'version'].sort()
    )
    expect(value.task).toEqual(JSON.parse(JSON.stringify(contract)))
  })

  it('refuses a task that is not a contract, or too large to carry', () => {
    expect(refused({ task: { version: 1, taskId: 't' } })).toMatch(/not a current task/)
    expect(refused({ task: 'task' })).toMatch(/not a current task/)
    expect(
      refused({ task: { ...task(), originalText: 'x'.repeat(HANDOFF_LIMITS.taskChars) } })
    ).toMatch(/too large/)
  })

  it('reads a packet saved before versions existed', () => {
    expect(parsed()).toMatchObject({ version: HANDOFF_VERSION })
  })

  it('refuses a newer version rather than guess at it', () => {
    expect(refused({ version: HANDOFF_VERSION + 1 })).toMatch(/version 2/)
    expect(refused({ version: 'x' })).toMatch(/version x/)
  })

  it('changes nothing when a parsed packet is parsed again', () => {
    const once = parsed({
      task: task(),
      summary: 's'.repeat(HANDOFF_LIMITS.textChars * 2),
      parentGoal: 'p'.repeat(HANDOFF_LIMITS.textChars * 2),
      files: ['/etc/passwd', 'a.ts'],
      constraints: ['keep it']
    })
    expect(parseHandoff(once)).toEqual({ ok: true, packet: once })
  })
})

describe('tool aliases', () => {
  const pairs = [['agent_id', 'agentId']] as const
  it('refuses two spellings that disagree', () => {
    expect(conflictingAliases({ agent_id: 'a', agentId: 'b' }, pairs)).toMatch(/disagree/)
  })
  it('accepts one spelling, or both agreeing', () => {
    expect(conflictingAliases({ agentId: 'b' }, pairs)).toBeNull()
    expect(conflictingAliases({ agent_id: 'b', agentId: 'b' }, pairs)).toBeNull()
  })
})

describe('at the queue', () => {
  const load = async () => {
    vi.resetModules()
    return import('../electron/main/services/background-agents')
  }
  const enqueue = async (handoff: unknown) =>
    (await load()).enqueueBackgroundJob(h.root, {
      goal: 'Check the validator',
      model: 'local:t',
      handoff: handoff as AgentHandoffPacket
    })
  const save = (jobs: unknown[]) =>
    writeFileSync(join(h.root, 'background-jobs.json'), JSON.stringify({ jobs }))
  const saved = (handoff: unknown, status = 'done') => ({
    id: 'saved',
    workspacePath: h.root,
    worktreePath: '',
    branch: '',
    goal: 'g',
    model: 'local:t',
    agentId: 'reviewer',
    status,
    step: 0,
    actionLog: [],
    filesTouched: [],
    answer: 'kept',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    handoff
  })
  beforeEach(() => rmSync(join(h.root, 'background-jobs.json'), { force: true }))

  it('refuses before anything is saved, with the same reason as the tool', async () => {
    const reason = refused({ confidence: 2 })
    await expect(enqueue(packet({ confidence: 2 }))).rejects.toThrow(reason)
    const { listBackgroundJobs } = await import('../electron/main/services/background-agents')
    expect(listBackgroundJobs(null)).toEqual([])
    expect(h.runs).toEqual([])
  })

  it('gives a queued job the packet an inline specialist would get', async () => {
    const input = packet({ apiKey: 'sk-secret', files: ['/etc/passwd', 'a.ts'] })
    const job = await enqueue(input)
    expect(job.handoff).toEqual(parsed(input))
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(h.runs[0]!.messages).toEqual(handoffMessages(parsed(input)))
  })

  it('reads an older saved job through a compatible migration', async () => {
    save([saved(packet())])
    const { getBackgroundJob } = await load()
    expect(getBackgroundJob('saved')?.handoff).toMatchObject({ version: HANDOFF_VERSION })
    expect(getBackgroundJob('saved')?.error).toBeUndefined()
  })

  it.each([
    ['newer', packet({ version: HANDOFF_VERSION + 1 })],
    ['malformed', { goal: 42 }]
  ])('keeps the record of a %s saved job but not its handoff', async (_name, handoff) => {
    save([saved(handoff)])
    const { getBackgroundJob } = await load()
    const job = getBackgroundJob('saved')!
    expect(job.handoff).toBeNull()
    expect(job.answer).toBe('kept')
    expect(job.error).toMatch(/Saved handoff not used/)
  })

  it('cannot run an interrupted job with an unreadable handoff', async () => {
    save([saved(packet({ version: HANDOFF_VERSION + 1 }), 'queued')])
    const { getBackgroundJob } = await load()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getBackgroundJob('saved')).toMatchObject({ status: 'stopped', handoff: null })
    expect(h.runs).toEqual([])
  })
})
