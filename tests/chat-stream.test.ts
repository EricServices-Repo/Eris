/* eslint-disable require-yield -- fake runners only need to exercise approveCommand */
import { randomUUID } from 'crypto'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { TurnPlan } from '../src/shared/settings-schema'

type RunnerOptions = {
  workspacePath: string
  turnPlan: TurnPlan
  approveCommand: (kind: 'run' | 'push', command: string) => Promise<boolean>
}
type RunnerEvent = Record<string, unknown> & { type: string }

const runner = vi.hoisted(() => ({
  script: async function* (_opts: RunnerOptions): AsyncGenerator<RunnerEvent> {}
}))

vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: (opts: RunnerOptions) => runner.script(opts)
}))
vi.mock('../electron/main/services/task-resolver', () => ({
  resolveTaskIntent: async (input: { fallback: string }) => input.fallback,
  resolveTaskDecision: async (input: { fallback: string }) => ({
    intent: input.fallback,
    initialIntent: input.fallback,
    source: 'bypass',
    rule: 'test',
    durationMs: 0
  })
}))
vi.mock('../electron/main/services/task-outcome', () => ({
  reviewTaskOutcome: async () => ({ verdict: 'supported', reason: 'test verdict' })
}))
vi.mock('../electron/main/services/builtin-model', async () => {
  const actual = await vi.importActual<typeof import('../electron/main/services/builtin-model')>(
    '../electron/main/services/builtin-model'
  )
  return {
    ...actual,
    isExactBuiltinReady: () => true,
    resolveExactBuiltinRef: (model: string) => model
  }
})
vi.mock('../electron/main/services/diagnostics', () => ({ setDiagnosticsPaused: () => undefined }))
vi.mock('../electron/main/ipc/shared', () => ({
  getSecret: () => '',
  abortAllCompletes: () => undefined
}))

const { registerChatStreamIpc } = await import('../electron/main/ipc/chat-stream')
const { appState } = await import('../electron/main/app-state')
const { workspaceAllowedCommands } = await import('../electron/main/services/workspace-trust')
const { getResolvedSettings } = await import('../electron/main/services/settings')

type Handler = (event: unknown, ...args: unknown[]) => unknown
let handlers: Record<string, Handler> = {}
let sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
/** Decision the fake renderer answers approval prompts with (null = never answer) */
let reply: 'allow' | 'always' | 'deny' | null = 'allow'

const sender = {
  isDestroyed: () => false,
  send: (channel: string, payload: Record<string, unknown>) => {
    sent.push({ channel, payload })
    if (channel === 'chat:approval-request' && reply) {
      const decision = reply
      queueMicrotask(() => {
        void handlers['chat:approvalRespond']!(null, payload.approvalId, decision)
      })
    }
  }
}

const plan: TurnPlan = {
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'full',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'manual'
}

function stream(prompt?: Record<string, unknown>, requestId = randomUUID()) {
  return handlers['chat:stream']!(
    { sender },
    {
      requestId,
      model: 'builtin:composer-lite',
      mode: 'agent',
      turnPlan: plan,
      ...(prompt
        ? {
            prompt: {
              mode: 'agent',
              agentId: 'composer',
              skillIds: [],
              attachments: [],
              history: [],
              ...prompt
            }
          }
        : { messages: [{ role: 'user', content: 'do it' }] })
    }
  )
}

const channels = () => sent.map((s) => s.channel)

beforeEach(() => {
  handlers = {}
  sent = []
  reply = 'allow'
  vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: Handler) => {
    handlers[channel] = fn
  }) as never)
  registerChatStreamIpc()
  appState.currentWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'eris-chat-')))
})

describe('chat:stream command approval', () => {
  it('runs safe commands without prompting', async () => {
    const results: boolean[] = []
    runner.script = async function* (opts) {
      results.push(await opts.approveCommand('run', 'git status'))
      yield { type: 'answer', text: 'ok' }
    }
    expect(await stream()).toBe(true)
    expect(results).toEqual([true])
    expect(channels()).not.toContain('chat:approval-request')
    expect(channels()).toContain('chat:done')
  })

  it('blocks a denied command', async () => {
    reply = 'deny'
    const results: boolean[] = []
    runner.script = async function* (opts) {
      results.push(await opts.approveCommand('run', 'rm -rf build'))
    }
    await stream()
    expect(results).toEqual([false])
    expect(channels()).toContain('chat:approval-resolved')
  })

  it('"always" remembers the command for this workspace only', async () => {
    reply = 'always'
    const results: boolean[] = []
    runner.script = async function* (opts) {
      results.push(await opts.approveCommand('run', 'make  deploy'))
      reply = null
      results.push(await opts.approveCommand('run', 'make deploy'))
    }
    await stream()
    expect(results).toEqual([true, true])
    expect(channels().filter((c) => c === 'chat:approval-request')).toHaveLength(1)
    expect(workspaceAllowedCommands(appState.currentWorkspace)).toEqual(['make deploy'])
    expect(getResolvedSettings(null).agent.allowedCommands).not.toContain('make deploy')
  })

  it('chat:stop denies a pending approval and ends the stream as aborted', async () => {
    reply = null
    const results: boolean[] = []
    runner.script = async function* (opts) {
      const pending = opts.approveCommand('run', 'rm -rf build')
      queueMicrotask(() => void handlers['chat:stop']!(null))
      results.push(await pending)
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    expect(await stream()).toBe(false)
    expect(results).toEqual([false])
    const done = sent.find((s) => s.channel === 'chat:done')
    expect(done?.payload.aborted).toBe(true)
  })
})

describe('main-process task authority', () => {
  it('ignores a renderer editing plan when the request is a review', async () => {
    let actual: TurnPlan | undefined
    runner.script = async function* (options) {
      actual = options.turnPlan
      yield { type: 'answer', text: 'Findings from the selected project.' }
    }
    await stream({ text: 'Review the code, improve it for the Airbnb website' })
    expect(actual?.intent).toBe('review')
    expect(actual?.task?.authority.edit).toBe(false)
    expect(actual?.task?.originalText).toContain('Airbnb')
  })
  it('executes one request ID once', async () => {
    let calls = 0
    runner.script = async function* () {
      calls++
      yield { type: 'answer', text: 'Answer' }
    }
    const requestId = randomUUID()
    await stream(undefined, requestId)
    await stream(undefined, requestId)
    expect(calls).toBe(1)
  })
  it('keeps the execution workspace bound after a workspace switch', async () => {
    const original = appState.currentWorkspace
    runner.script = async function* (options) {
      appState.currentWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'eris-other-')))
      expect(options.workspacePath).toBe(original)
      expect(options.turnPlan.task?.scope.workspaceRoot).toBe(original)
      yield { type: 'answer', text: 'Bound to original workspace' }
    }
    await stream()
    const { getLatestChatJob } = await import('../electron/main/services/chat-job-controller')
    expect(getLatestChatJob(original)?.workspacePath).toBe(original)
  })
  it('persists incomplete outcomes without relabeling them done', async () => {
    const original = appState.currentWorkspace
    runner.script = async function* () {
      yield { type: 'progress', step: 1, filesTouched: [], actionLog: [], incomplete: true }
      yield { type: 'answer', text: 'Incomplete: source evidence missing.' }
    }
    await stream()
    const { getLatestChatJob } = await import('../electron/main/services/chat-job-controller')
    expect(getLatestChatJob(original)?.status).toBe('incomplete')
  })
})
