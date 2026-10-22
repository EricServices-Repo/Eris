import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type {
  BlockedEffectKind,
  DebugModelCall,
  ScriptedVerifySchema
} from '../src/shared/debug-runs'
import type { z } from 'zod'

/**
 * App-level diagnostics path: the real chat:stream handler, task intake, agent
 * loop, tool execution, and approval IPC run on a scripted model transport.
 * Nothing here may reach a provider, and refused effects must be reported at
 * their own boundary rather than depending on options a caller remembered.
 */
const provider = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../electron/main/services/openai-compatible', () => ({
  streamOpenAICompatible: async function* (options: { model: string }) {
    provider.calls.push(options.model)
    yield ''
  }
}))
vi.mock('../electron/main/services/builtin-model', async () => {
  const actual = await vi.importActual<typeof import('../electron/main/services/builtin-model')>(
    '../electron/main/services/builtin-model'
  )
  return {
    ...actual,
    streamBuiltinChat: async function* (options: { modelRef: string }) {
      provider.calls.push(options.modelRef)
      yield ''
    }
  }
})
// Secret storage and terminal/LSP lifecycles are outside the path under test.
vi.mock('../electron/main/ipc/shared', () => ({
  getSecret: () => '',
  abortAllCompletes: () => undefined
}))

const { registerChatStreamIpc } = await import('../electron/main/ipc/chat-stream')
const { appState } = await import('../electron/main/app-state')
const { setSettings } = await import('../electron/main/services/settings')
const { getChatJob } = await import('../electron/main/services/chat-job-controller')
const { materializeSandboxFiles } = await import('../electron/main/services/eval-runner')
const { findDebugScenario } = await import('../electron/main/services/debug-runs/scenarios')
const { ScriptedModelAdapter } = await import('../electron/main/services/debug-runs/model-adapters')
const { runInDiagnosticsScope, SIMULATED_MODEL_REF } =
  await import('../electron/main/services/model-transport')

type ScriptQueues = ConstructorParameters<typeof ScriptedModelAdapter>[0]
type Handler = (event: unknown, ...args: unknown[]) => unknown
type Payload = Record<string, unknown> & { requestId?: string }

let handlers: Record<string, Handler> = {}
let sent: Array<{ channel: string; payload: Payload }> = []
/** Decision the fake renderer answers approval prompts with. */
let reply: 'allow' | 'deny' = 'allow'
let workspace = ''

const sender = {
  isDestroyed: () => false,
  send: (channel: string, payload: Payload) => {
    sent.push({ channel, payload })
    if (channel === 'chat:approval-request') {
      const decision = reply
      queueMicrotask(() => {
        void handlers['chat:approvalRespond']!(null, payload.approvalId, decision)
      })
    }
  }
}

const tool = (name: string, args: Record<string, unknown>) => ({
  text: JSON.stringify({ name, ...args })
})

/** Submit one chat:stream request inside a simulated diagnostics scope. */
async function scriptedTurn(
  text: string,
  script: ScriptQueues,
  verify: Array<z.infer<typeof ScriptedVerifySchema>> = []
) {
  const requestId = randomUUID()
  const calls: DebugModelCall[] = []
  const blocked: Array<{ kind: BlockedEffectKind; detail: string }> = []
  const result = await runInDiagnosticsScope(
    {
      runId: `ipc-${requestId}`,
      mode: 'simulated',
      adapter: new ScriptedModelAdapter(script, 'scripted', (call) => calls.push(call)),
      onBlockedEffect: (kind, detail) => blocked.push({ kind, detail }),
      verify: () => {
        const next = verify.shift()
        return next
          ? { ok: next.ok, command: next.command, detail: next.detail }
          : { ok: true, skipped: true, command: '', detail: 'verify skipped' }
      }
    },
    () =>
      handlers['chat:stream']!(
        { sender },
        {
          requestId,
          model: SIMULATED_MODEL_REF,
          mode: 'agent',
          workspacePath: workspace,
          prompt: { text, mode: 'agent', agentId: '', skillIds: [], attachments: [], history: [] }
        }
      )
  )
  const events = sent.filter((item) => item.payload.requestId === requestId)
  const of = (channel: string) =>
    events.filter((item) => item.channel === channel).map((item) => item.payload)
  return { requestId, result, calls, blocked, of }
}

beforeEach(() => {
  handlers = {}
  sent = []
  reply = 'allow'
  provider.calls.length = 0
  vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: Handler) => {
    handlers[channel] = fn
  }) as never)
  registerChatStreamIpc()
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'eris-ipc-diagnostics-')))
  materializeSandboxFiles(workspace, findDebugScenario('edit-explicit-fix')!.fixture)
  appState.currentWorkspace = workspace
})

describe('chat:stream on a scripted diagnostics transport', () => {
  it('runs a real edit turn end to end without any provider call', async () => {
    const scenario = findDebugScenario('edit-explicit-fix')!
    const { agent, route, intent, outcome } = scenario.script
    const turn = await scriptedTurn(scenario.request.text, { agent, route, intent, outcome }, [
      ...scenario.script.verify
    ])

    expect(turn.result).toBe(true)
    expect(provider.calls).toEqual([])
    expect(turn.calls.length).toBeGreaterThan(0)
    expect(turn.calls.every((call) => call.source === 'scripted' && !call.error)).toBe(true)
    expect(turn.of('chat:error')).toEqual([])

    expect(turn.of('chat:task')[0]?.task).toMatchObject({
      deliverable: 'patch',
      authority: { edit: true }
    })
    expect(turn.of('chat:routed')[0]).toMatchObject({ intent: 'edit', model: SIMULATED_MODEL_REF })
    const finished = turn
      .of('chat:tool')
      .map((item) => item.tool as { name: string; status: string })
      .filter((item) => item.status !== 'running')
      .map((item) => `${item.name}:${item.status}`)
    expect(finished).toEqual(expect.arrayContaining(['read_file:ok', 'search_replace:ok']))
    expect(turn.of('chat:diff').map((item) => (item.diff as { path: string }).path)).toEqual([
      'src/divide.ts'
    ])
    expect(turn.of('chat:outcome')[0]).toMatchObject({ verdict: 'supported' })
    expect(turn.of('chat:done')).toEqual([{ requestId: turn.requestId, incomplete: false }])

    expect(readFileSync(join(workspace, 'src/divide.ts'), 'utf8')).toContain(
      'if (right === 0) return 0'
    )
    expect(getChatJob(turn.requestId)?.status).toBe('done')
    expect(turn.blocked).toEqual([])
  })

  it.each([
    ['allow', ['command'], 'execution_failed'],
    ['deny', [], 'permission_denied']
  ] as const)(
    'asks the renderer to approve a command; after %s no host process runs',
    async (decision, refused, failure) => {
      reply = decision
      const turn = await scriptedTurn('Run npm run release and tell me whether it succeeds.', {
        agent: [
          tool('run', { command: 'npm run release' }),
          { text: 'DONE: npm run release did not run in this session.' }
        ]
      })

      expect(provider.calls).toEqual([])
      expect(turn.of('chat:approval-request')).toEqual([
        expect.objectContaining({ kind: 'run', command: 'npm run release' })
      ])
      expect(turn.of('chat:approval-resolved')).toEqual([expect.objectContaining({ decision })])
      // An allowed command reaches the host boundary and is refused there.
      expect(turn.blocked.map((item) => item.kind)).toEqual(refused)
      const run = turn
        .of('chat:tool')
        .map((item) => item.tool as { name: string; status: string; failure?: { code: string } })
        .find((item) => item.name === 'run' && item.status !== 'running')
      expect(run).toMatchObject({ status: 'error', failure: { code: failure } })
      expect(turn.of('chat:done')).toHaveLength(1)
      expect(turn.of('chat:done')[0]?.aborted).toBeUndefined()
    }
  )

  it('never starts a configured MCP server or offers its tools', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'eris-mcp-marker-')), 'spawned')
    setSettings(
      'user',
      {
        mcp: {
          servers: [
            {
              id: 'marker',
              name: 'Marker',
              enabled: true,
              transport: 'stdio',
              command: process.execPath,
              args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
              url: '',
              env: {},
              notes: ''
            }
          ]
        }
      },
      null
    )
    try {
      const turn = await scriptedTurn('How does retry timing work in this project?', {
        agent: [
          tool('read_file', { path: 'src/retry.ts' }),
          { text: 'Retry timing in src/retry.ts: capped exponential backoff, three retries.' }
        ],
        intent: [{ text: JSON.stringify({ intent: 'explore', confidence: 0.95 }) }]
      })

      expect(existsSync(marker)).toBe(false)
      expect(turn.blocked).toEqual([{ kind: 'mcp', detail: expect.stringContaining('Marker') }])
      expect(provider.calls).toEqual([])
      expect(turn.of('chat:done')).toHaveLength(1)
    } finally {
      setSettings('user', { mcp: { servers: [] } }, null)
    }
  })
})
