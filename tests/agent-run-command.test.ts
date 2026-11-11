import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #503: "Run ls -la … and tell me how many files there are" finished with an
 * answer guessed from a directory listing and no run call. The loop must not
 * accept a run turn until the run tool was called.
 */

const state = vi.hoisted(() => ({
  script: [] as string[],
  calls: 0,
  verify: { ok: true, skipped: true, command: '', detail: 'No typecheck/test/lint script found — skipped verify.', skipReason: 'no-project-check' } as Record<string, unknown>
}))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* () {
    state.calls++
    yield state.script.shift() ?? 'Finished.'
  }
}))
vi.mock('../electron/main/services/verify', () => ({ runVerify: async () => ({ ...state.verify }) }))
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

import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'eris-run-command-')))
  state.script.length = 0
  state.calls = 0
  state.verify = { ok: true, skipped: true, command: '', detail: 'No typecheck/test/lint script found — skipped verify.', skipReason: 'no-project-check' }
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const plan = (): TurnPlan => ({
  intent: 'run', agentId: 'composer', agentName: 'Composer', mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'full', requiresTools: true, escalateToFull: false, reason: 'test', method: 'manual'
})
const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ name, ...args })

async function run(text: string) {
  const turnPlan = plan()
  turnPlan.task = createTaskContract({ workspacePath: ws, text, plan: turnPlan })
  const events: Array<Record<string, unknown>> = []
  for await (const event of runAgentWithWorkspaceTools({
    workspacePath: ws, settings: getDefaults(), model: 'builtin:composer-lite',
    messages: [{ role: 'user', content: text }], temperature: 0, getSecret: () => null,
    mode: 'agent', turnPlan, mcp: 'off'
  }))
    events.push(event as Record<string, unknown>)
  const answer = events.filter((e) => e.type === 'answer')
    .reduce((text, e) => (e.replace ? String(e.text) : text + String(e.text)), '')
  return { events, answer, incomplete: events.some((e) => e.incomplete === true) }
}

describe('#503 run turns', () => {
  it('does not finish a run request answered from a listing alone', async () => {
    writeFileSync(join(ws, 'a.txt'), 'a')
    writeFileSync(join(ws, 'b.txt'), 'b')
    state.script.push(
      call('list_dir', { path: '.' }),
      'There are 2 files in the project folder.',
      'There are 2 files in the project folder.',
      'There are 2 files in the project folder.',
      'There are 2 files in the project folder.'
    )
    const result = await run('Run ls -la in the project folder and tell me how many files there are.')
    expect(result.incomplete).toBe(true)
    expect(JSON.stringify(result.events)).toMatch(/asked you to run `ls -la`/)
  }, 30_000)

  it('finishes once the command ran and the answer reports it', async () => {
    writeFileSync(join(ws, 'a.txt'), 'a')
    setWorkspaceTrusted(ws, true)
    state.script.push(
      call('run', { command: 'ls -la' }),
      'I ran `ls -la`: the project folder has 1 file, a.txt.'
    )
    const result = await run('Run ls -la in the project folder and tell me how many files there are.')
    expect(result.events.some((e) => (e.tool as { name?: string } | undefined)?.name === 'run')).toBe(true)
    expect(result.incomplete).toBe(false)
    expect(result.answer).toMatch(/a\.txt/)
  }, 30_000)
})
