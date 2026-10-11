/* eslint-disable require-yield -- fake runners only need to exercise approveCommand */
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { TurnPlan } from '../src/shared/settings-schema'

type RunnerOptions = {
  approveCommand: (kind: 'run' | 'push', command: string) => Promise<boolean>
  resume?: { goal: string; actionLog: string[]; filesTouched: string[] }
}
type RunnerEvent = Record<string, unknown> & { type: string }

const runner = vi.hoisted(() => ({
  script: async function* (_opts: RunnerOptions): AsyncGenerator<RunnerEvent> {}
}))

vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: (opts: RunnerOptions) => runner.script(opts)
}))
vi.mock('../electron/main/services/diagnostics', () => ({ setDiagnosticsPaused: () => undefined }))
vi.mock('../electron/main/ipc/shared', () => ({
  getSecret: () => '',
  abortAllCompletes: () => undefined
}))

const { registerChatStreamIpc } = await import('../electron/main/ipc/chat-stream')
const { appState } = await import('../electron/main/app-state')
const { workspaceAllowedCommands } = await import('../electron/main/services/workspace-trust')
const { getResolvedSettings } = await import('../electron/main/services/settings')
const { saveAgentRun, loadLastAgentRun } = await import('../electron/main/services/agent-runs')

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

function stream(prompt?: Record<string, unknown>) {
  return handlers['chat:stream']!(
    { sender },
    {
      requestId: 'req-1',
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

describe('chat:stream resume', () => {
  it('continues a persisted run with its goal and progress', async () => {
    const ws = appState.currentWorkspace!
    saveAgentRun(ws, {
      id: 'run-1',
      requestId: 'old-req',
      goal: 'Finish the refactor',
      agentId: 'composer',
      mode: 'agent',
      checkpointId: 'cp-0',
      status: 'incomplete',
      step: 4,
      actionLog: ['edited a.ts'],
      filesTouched: ['a.ts'],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    let seenResume: RunnerOptions['resume']
    runner.script = async function* (opts) {
      seenResume = opts.resume
      yield { type: 'checkpoint', checkpointId: 'cp-1' }
      yield {
        type: 'progress',
        step: 6,
        actionLog: ['edited a.ts', 'edited b.ts'],
        filesTouched: ['a.ts', 'b.ts']
      }
      yield { type: 'answer', text: 'done' }
    }
    await stream({ text: 'continue', resumeRunId: 'run-1' })

    expect(seenResume).toEqual({
      goal: 'Finish the refactor',
      actionLog: ['edited a.ts'],
      filesTouched: ['a.ts']
    })
    const run = loadLastAgentRun(ws)!
    expect(run.id).toBe('run-1')
    expect(run.goal).toBe('Finish the refactor')
    expect(run.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(run.step).toBe(6)
    expect(run.filesTouched).toEqual(['a.ts', 'b.ts'])
    expect(run.status).toBe('done')
  })

  it('ignores a stale resume id', async () => {
    let seenResume: RunnerOptions['resume'] = { goal: 'x', actionLog: [], filesTouched: [] }
    runner.script = async function* (opts) {
      seenResume = opts.resume
    }
    await stream({ text: 'hello', resumeRunId: 'missing' })
    expect(seenResume).toBeUndefined()
  })
})
