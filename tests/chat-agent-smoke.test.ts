import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * High level smoke coverage for the failure modes seen with small local models.
 * The scripted model is intentionally unreliable; the agent loop must recover,
 * make the requested edits, verify them, and return a useful final answer.
 */
const harness = vi.hoisted(() => ({
  replies: [] as string[],
  prompts: [] as string[],
  nativeCalls: [] as Array<Array<{ id: string; name: string; arguments: string }> | undefined>,
  transcripts: [] as Array<Array<{ role: string; content: string; tool_calls?: unknown[] }>>,
  requestModes: [] as Array<{ constrained: boolean; sessionKey?: string }>,
  releasedSessions: [] as string[],
  verifyCalls: 0,
  verifyResults: [] as Array<{
    ok: boolean
    skipped: boolean
    command: string
    detail: string
  }>
}))

vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: {
    messages: Array<{ role: string; content: string }>
    builtinJsonSchema?: Record<string, unknown>
    sessionKey?: string
    onNativeToolCalls?: (calls: Array<{ id: string; name: string; arguments: string }>) => void
  }) {
    harness.requestModes.push({
      constrained: Boolean(options.builtinJsonSchema),
      sessionKey: options.sessionKey
    })
    harness.prompts.push(options.messages.map((message) => message.content).join('\n'))
    harness.transcripts.push(structuredClone(options.messages))
    const native = harness.nativeCalls.shift()
    if (native) options.onNativeToolCalls?.(native)
    yield harness.replies.shift() ?? 'DONE: The smoke-test model ran out of scripted replies.'
  }
}))

// The transport is scripted: model readiness must not depend on local downloads.
vi.mock('../electron/main/services/builtin-model', async () => {
  const actual = await vi.importActual<typeof import('../electron/main/services/builtin-model')>(
    '../electron/main/services/builtin-model'
  )
  return {
    ...actual,
    releaseLocalChatSession: (key: string) => {
      harness.releasedSessions.push(key)
    },
    isExactBuiltinReady: () => true,
    resolveExactBuiltinRef: (ref: string) => ref
  }
})

vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => {
    harness.verifyCalls++
    return (
      harness.verifyResults.shift() ?? {
        ok: true,
        skipped: false,
        command: 'npm test',
        detail: 'smoke verification passed'
      }
    )
  }
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

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'

import { getDefaults } from '../electron/main/services/settings'
import type { AgentChatMessage, AgentRunnerEvent } from '../electron/main/services/agent/types'
import type { TurnPlan } from '../src/shared/settings-schema'

let workspacePath: string

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'eris-chat-smoke-'))
  setWorkspaceTrusted(workspacePath, true)
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(
    join(workspacePath, 'src', 'divide.ts'),
    [
      '/**',
      ' * Divide two values for the reporting pipeline.',
      ' * The extra documentation keeps this representative of a real source file',
      ' * rather than a tiny generated stub.',
      ' */',
      'export function safeDivide(left: number, right: number): number {',
      '  return left / right',
      '}',
      '',
      'export function formatRatio(left: number, right: number): string {',
      '  return safeDivide(left, right).toFixed(2)',
      '}',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(workspacePath, 'src', 'retry.ts'),
    [
      'export const MAX_RETRIES = 3',
      '',
      'export function retryDelay(attempt: number): number {',
      '  return Math.min(250 * 2 ** attempt, 4_000)',
      '}',
      ''
    ].join('\n')
  )
  harness.nativeCalls.length = 0
  harness.transcripts.length = 0
  harness.replies.length = 0
  harness.prompts.length = 0
  harness.requestModes.length = 0
  harness.releasedSessions.length = 0
  harness.verifyCalls = 0
  harness.verifyResults.length = 0
})

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true })
})

function fullEditPlan(): TurnPlan {
  return {
    intent: 'edit',
    agentId: 'composer',
    agentName: 'Composer',
    mode: 'agent',
    models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
    toolPolicy: 'full',
    requiresTools: true,
    escalateToFull: false,
    reason: 'chat smoke test',
    method: 'manual'
  }
}

function workspaceQuestionPlan(): TurnPlan {
  return {
    intent: 'explore',
    agentId: 'explainer',
    agentName: 'Explainer',
    mode: 'agent',
    models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
    toolPolicy: 'read',
    requiresTools: true,
    escalateToFull: false,
    reason: 'workspace question smoke test',
    method: 'manual'
  }
}

async function drain(generator: AsyncGenerator<AgentRunnerEvent>): Promise<AgentRunnerEvent[]> {
  const events: AgentRunnerEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

function toolsFrom(events: AgentRunnerEvent[]) {
  return events
    .filter((event): event is Extract<AgentRunnerEvent, { type: 'tool' }> => event.type === 'tool')
    .map((event) => event.tool)
}

function lastAnswer(events: AgentRunnerEvent[]): string {
  return (
    [...events]
      .reverse()
      .find(
        (event): event is Extract<AgentRunnerEvent, { type: 'answer' }> => event.type === 'answer'
      )?.text ?? ''
  )
}

function expectCompleted(events: AgentRunnerEvent[]): void {
  expect(events.some((event) => event.type === 'progress' && event.incomplete === true)).toBe(false)
  expect(lastAnswer(events).trim().length).toBeGreaterThan(20)
}

describe('chat agent complex smoke test', () => {
  it('answers a workspace question after inspecting files instead of asking the user to paste them', async () => {
    const retryBefore = readFileSync(join(workspacePath, 'src', 'retry.ts'), 'utf8')
    harness.replies.push(
      'Please paste the project structure and the relevant source files.',
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      'The retry policy is defined in src/retry.ts. It allows three retries and uses capped exponential backoff starting at 250 ms.'
    )

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [
          { role: 'system', content: 'You are Explainer.' },
          { role: 'user', content: 'How does retry timing work in this project?' }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: workspaceQuestionPlan(),
        mcp: 'off'
      })
    )

    const toolEvents = toolsFrom(events)
    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tree', status: 'ok' }),
        expect.objectContaining({ name: 'read_file', path: 'src/retry.ts', status: 'ok' })
      ])
    )
    expect(events.some((event) => event.type === 'diff')).toBe(false)
    expect(readFileSync(join(workspacePath, 'src', 'retry.ts'), 'utf8')).toBe(retryBefore)
    expect(harness.verifyCalls).toBe(0)

    expect(lastAnswer(events)).toContain('src/retry.ts')
    expect(lastAnswer(events)).toContain('three retries')
    expectCompleted(events)
    expect(harness.replies).toHaveLength(0)
  })

  it('rejects a false DONE response until a real product file is created', async () => {
    const moduleBody = [
      '/** Runtime configuration used by the smoke fixture. */',
      "export const config = { mode: 'safe', retries: 3 } as const",
      '',
      'export function describeConfig(): string {',
      '  return `mode=${config.mode}; retries=${config.retries}`',
      '}',
      '',
      '// This fixture is intentionally substantial enough to represent a completed module.',
      '// The agent goal checker should accept it only after the write tool succeeds.',
      ''
    ].join('\n')
    harness.replies.push(
      'DONE: The requested configuration module is complete.',
      JSON.stringify({ name: 'write_file', path: 'src/config.ts', content: moduleBody }),
      'DONE: Created src/config.ts with the requested runtime configuration and helper.'
    )

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Create src/config.ts with runtime configuration.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )

    expect(readFileSync(join(workspacePath, 'src', 'config.ts'), 'utf8')).toBe(moduleBody)
    expect(
      harness.prompts.some(
        (prompt) =>
          prompt.includes('No files written yet') || prompt.includes('You must use tools to finish')
      )
    ).toBe(true)
    expect(toolsFrom(events)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'write_file', status: 'ok' })])
    )
    expectCompleted(events)
    expect(harness.replies).toHaveLength(0)
  })

  it('recovers after a denied command without retrying the denied action', async () => {
    const deniedCommand = 'node dangerous-check.js'
    harness.replies.push(
      JSON.stringify({ name: 'run', command: deniedCommand }),
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      JSON.stringify({
        name: 'search_replace',
        path: 'src/retry.ts',
        old_string: 'export const MAX_RETRIES = 3',
        new_string: 'export const MAX_RETRIES = 4'
      }),
      'DONE: Updated the retry limit to four and continued safely after the command was denied.'
    )
    const approvals: string[] = []

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Update the retry limit to four and run the check.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off',
        approveCommand: async (_kind, command) => {
          approvals.push(command)
          return false
        }
      })
    )

    expect(approvals).toEqual([deniedCommand])
    expect(readFileSync(join(workspacePath, 'src', 'retry.ts'), 'utf8')).toContain(
      'MAX_RETRIES = 4'
    )
    expect(toolsFrom(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'run',
          status: 'error',
          failure: expect.objectContaining({ code: 'permission_denied', retryable: false })
        }),
        expect.objectContaining({ name: 'search_replace', status: 'ok' })
      ])
    )
    expect(
      harness.prompts.some((prompt) => prompt.includes('Do not retry this blocked action'))
    ).toBe(true)
    expectCompleted(events)
    expect(harness.replies).toHaveLength(0)
  })

  it('counts different ranges of the same source as evidence beyond six rounds', async () => {
    for (let line = 1; line <= 9; line++)
      harness.replies.push(
        JSON.stringify({
          name: 'read_file',
          path: 'src/divide.ts',
          start_line: line,
          end_line: line
        })
      )
    harness.replies.push(
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      JSON.stringify({
        name: 'search_replace',
        path: 'src/retry.ts',
        old_string: 'MAX_RETRIES = 3',
        new_string: 'MAX_RETRIES = 4'
      }),
      'DONE: Updated the retry limit in src/retry.ts to four after inspecting the source ranges.'
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [
          {
            role: 'user',
            content:
              'Update the retry limit in src/retry.ts to four. Inspect source before editing.'
          }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )
    expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 4')
    expect(
      toolsFrom(events).filter((tool) => tool.name === 'read_file' && tool.status === 'ok')
    ).toHaveLength(10)
    expectCompleted(events)
    expect(lastAnswer(events)).not.toContain('Stopped after')
    expect(harness.replies).toHaveLength(0)
  })

  it('synthesizes a stalled review instead of posting its promise to keep reading', async () => {
    const before = readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')
    harness.replies.push(
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      ...Array.from(
        { length: 6 },
        () =>
          'I need to read more files to complete the review. Let me check the remaining source files.'
      ),
      '1. Make MAX_RETRIES configurable in src/retry.ts.\n2. Add jitter to retryDelay in src/retry.ts.\n3. Test the 4,000 ms backoff cap in src/retry.ts.'
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Review the project and recommend 3 improvements.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: { ...workspaceQuestionPlan(), intent: 'review', toolPolicy: 'full' },
        mcp: 'off'
      })
    )
    expectCompleted(events)
    expect(lastAnswer(events)).toContain('jitter')
    expect(lastAnswer(events)).not.toMatch(/Stopped after|I need to read/)
    expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toBe(before)
    expect(
      harness.prompts.some((prompt) => prompt.includes('Thinking is finished. Write the reply'))
    ).toBe(true)
    expect(harness.replies).toHaveLength(0)
  })

  it('gives a stalled edit a bounded recovery window that can reach a real change', async () => {
    harness.replies.push(
      ...Array.from(
        { length: 7 },
        () => 'I will inspect the source and make the requested changes.'
      ),
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      JSON.stringify({
        name: 'search_replace',
        path: 'src/retry.ts',
        old_string: 'MAX_RETRIES = 3',
        new_string: 'MAX_RETRIES = 4'
      }),
      'DONE: Updated src/retry.ts to allow four retries.'
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Update the retry limit to four.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )
    expect(harness.prompts.some((prompt) => prompt.includes('RECOVERY: The last attempts'))).toBe(
      true
    )
    expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 4')
    expectCompleted(events)
  })

  it('still bounds an irrecoverable model and reports the blocker once without fabricated edits', async () => {
    harness.replies.push(
      ...Array.from(
        { length: 30 },
        () => 'I will inspect the source and make the requested changes.'
      )
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Update the retry limit to four.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )
    expect(events.some((event) => event.type === 'progress' && event.incomplete)).toBe(true)
    expect(lastAnswer(events)).toContain('No file changes were made.')
    expect(lastAnswer(events)).not.toMatch(/Stopped after|What I did:/)
    expect(lastAnswer(events).match(/couldn’t complete/g)).toHaveLength(1)
    expect(harness.prompts.length).toBeLessThan(20)
    expect(
      harness.prompts.filter((prompt) => prompt.includes('RECOVERY: The last attempts')).length
    ).toBeGreaterThan(0)
    expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 3')
  })

  it('recovers an empty constrained reply after scaffolding a website and accepts a verified completion list', async () => {
    const paths = [
      'public/index.html',
      'public/styles/main.css',
      'public/js/main.js',
      'backend/app.py',
      'backend/templates/login.html',
      'backend/templates/register.html',
      'backend/templates/admin.html'
    ]
    harness.replies.push(
      JSON.stringify({ name: 'tree', path: '.' }),
      ...paths.map((path) =>
        JSON.stringify({
          name: 'write_file',
          path,
          content: '<!-- realistic source fixture -->\n'.repeat(15)
        })
      ),
      'I will inspect the implementation and make any remaining changes.',
      '',
      '1. Created the public news website in public/index.html.\n2. Implemented registration in backend/app.py.\n3. Created the admin templates in backend/templates/admin.html.'
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        jobId: 'empty-reply-regression',
        model: 'builtin:composer-lite',
        messages: [
          {
            role: 'user',
            content: 'Build a news media website with registration and an admin backend.'
          }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )
    expectCompleted(events)
    expect(lastAnswer(events)).toContain('registration')
    expect(harness.requestModes.at(-2)?.constrained).toBe(true)
    expect(harness.requestModes.at(-1)?.constrained).toBe(false)
    expect(harness.releasedSessions).toContain('gguf:empty-reply-regression')
    expect(
      harness.transcripts
        .at(-1)
        ?.some(
          (message) =>
            message.role === 'assistant' && !message.content.trim() && !message.tool_calls?.length
        )
    ).toBe(false)
    expect(harness.prompts.at(-1)).toContain('EMPTY_RESPONSE_RECOVERY')
    expect(harness.verifyCalls).toBeGreaterThan(0)
    for (const path of paths) expect(existsSync(join(workspacePath, path))).toBe(true)
    expect(
      toolsFrom(events).filter((tool) => tool.name === 'write_file' && tool.status === 'ok')
    ).toHaveLength(paths.length)
    expect(harness.replies).toHaveLength(0)
  })

  it('resumes missing edits after an empty reply instead of declaring partial work complete', async () => {
    harness.replies.push(
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      '',
      JSON.stringify({
        name: 'search_replace',
        path: 'src/retry.ts',
        old_string: 'MAX_RETRIES = 3',
        new_string: 'MAX_RETRIES = 4'
      }),
      'DONE: Updated the retry limit in src/retry.ts to four.'
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Update the retry limit to four.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )
    expectCompleted(events)
    expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 4')
    expect(harness.verifyCalls).toBeGreaterThan(0)
    expect(harness.replies).toHaveLength(0)
  })

  it('bounds repeated empty completions without saving empty assistant turns or claiming success', async () => {
    harness.replies.push(
      JSON.stringify({
        name: 'write_file',
        path: 'partial.html',
        content: '<main>Partial work</main>\n'.repeat(20)
      }),
      '',
      '',
      ''
    )
    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [
          { role: 'user', content: 'Build a news website with registration and admin pages.' }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )
    expect(events.some((event) => event.type === 'progress' && event.incomplete)).toBe(true)
    expect(lastAnswer(events)).toContain('empty responses after two fresh-session retries')
    expect(lastAnswer(events)).toContain('implementation has not been confirmed complete')
    expect(harness.prompts).toHaveLength(4)
    expect(
      harness.transcripts.every(
        (messages) =>
          !messages.some(
            (message) =>
              message.role === 'assistant' && !message.content.trim() && !message.tool_calls?.length
          )
      )
    ).toBe(true)
    expect(existsSync(join(workspacePath, 'partial.html'))).toBe(true)
    expect(harness.verifyCalls).toBe(0)
  })

  it('stops an identical mutating-tool loop and marks the run incomplete', async () => {
    const content = 'loop guard fixture\n'
    const repeatedWrite = JSON.stringify({ name: 'write_file', path: 'loop.txt', content })
    harness.replies.push(repeatedWrite, repeatedWrite, repeatedWrite, repeatedWrite, repeatedWrite)

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [{ role: 'user', content: 'Create loop.txt once.' }],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off'
      })
    )

    expect(readFileSync(join(workspacePath, 'loop.txt'), 'utf8')).toBe(content)
    expect(events.filter((event) => event.type === 'diff')).toHaveLength(1)
    expect(
      toolsFrom(events).filter((tool) => tool.name === 'write_file' && tool.status === 'ok')
    ).toHaveLength(1)
    expect(events.some((event) => event.type === 'progress' && event.incomplete === true)).toBe(
      true
    )
    expect(lastAnswer(events)).toContain('repeated identical tool calls')
    expect(harness.verifyCalls).toBe(0)
    expect(harness.replies).toHaveLength(0)
  })

  it('recovers from weak-model failures and makes a verified code change', async () => {
    const checkCommand =
      `node -e "const fs=require('fs');` +
      `const s=fs.readFileSync('src/divide.ts','utf8');` +
      `if(!s.includes('right === 0'))process.exit(1)"`

    harness.replies.push(
      'Could you please provide the project structure and source files?',
      JSON.stringify({
        name: 'search_replace',
        path: 'src/divide.ts',
        old_string: '  return left / right',
        new_string: '  if (right === 0) return 0\n  return left / right'
      }),
      JSON.stringify({ name: 'read_file', path: 7 }),
      JSON.stringify({ name: 'read_file', path: 'src/divide.ts' }),
      JSON.stringify({
        name: 'search_replace',
        path: 'src/divide.ts',
        old_string: '  return left / right',
        new_string: '  if (right === 0) return 0\n  return left / right'
      }),
      JSON.stringify({
        name: 'write_file',
        path: 'src/divide.test.ts',
        content:
          "import { safeDivide } from './divide'\n\n" +
          "if (safeDivide(8, 2) !== 4) throw new Error('division failed')\n" +
          "if (safeDivide(8, 0) !== 0) throw new Error('zero divisor failed')\n"
      }),
      JSON.stringify({ name: 'run', command: checkCommand }),
      JSON.stringify({ name: 'run', command: checkCommand }),
      'DONE: Implemented safe division and regression coverage; the command check passed.',
      JSON.stringify({ name: 'read_file', path: 'src/divide.ts' }),
      JSON.stringify({
        name: 'search_replace',
        path: 'src/divide.ts',
        old_string: '  if (right === 0) return 0',
        new_string: '  if (!Number.isFinite(right) || right === 0) return 0'
      }),
      'DONE: Implemented safe division for zero and non-finite divisors, added regression coverage, and verification passed.'
    )
    harness.verifyResults.push(
      {
        ok: false,
        skipped: false,
        command: 'npm test',
        detail: 'divide smoke suite: non-finite divisors are still failing'
      },
      {
        ok: true,
        skipped: false,
        command: 'npm test',
        detail: 'divide smoke suite passed'
      }
    )

    const approvals: string[] = []
    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'You are Composer.' },
      {
        role: 'user',
        content:
          'Fix safeDivide for zero and non-finite divisors, add regression coverage, and run a check.'
      }
    ]

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages,
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: fullEditPlan(),
        mcp: 'off',
        approveCommand: async (_kind, command) => {
          approvals.push(command)
          return true
        }
      })
    )

    const source = readFileSync(join(workspacePath, 'src', 'divide.ts'), 'utf8')
    expect(source).toContain('!Number.isFinite(right) || right === 0')
    expect(existsSync(join(workspacePath, 'src', 'divide.test.ts'))).toBe(true)

    const toolEvents = toolsFrom(events)
    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tree', status: 'ok' }),
        expect.objectContaining({
          name: 'search_replace',
          status: 'error',
          failure: expect.objectContaining({ code: 'precondition_failed', retryable: true })
        }),
        expect.objectContaining({
          name: 'read_file',
          status: 'error',
          failure: expect.objectContaining({ code: 'invalid_arguments' })
        }),
        expect.objectContaining({ name: 'write_file', status: 'ok' }),
        expect.objectContaining({ name: 'run', status: 'ok' })
      ])
    )

    // The repeated run call is skipped before execution or a second approval.
    expect(approvals).toEqual([checkCommand])
    expect(toolEvents.filter((tool) => tool.name === 'run' && tool.status === 'ok')).toHaveLength(1)

    expect(harness.verifyCalls).toBe(2)
    expect(harness.prompts.some((prompt) => prompt.includes('RECOVERY:'))).toBe(true)
    expect(harness.prompts.some((prompt) => prompt.includes('VERIFY_RESULT (failed)'))).toBe(true)
    expect(events.filter((event) => event.type === 'diff')).toHaveLength(3)
    expect(events.filter((event) => event.type === 'workspace-changed')).toHaveLength(3)
    expectCompleted(events)
    expect(lastAnswer(events)).toContain('verification passed')
    expect(harness.replies).toHaveLength(0)
  })
})

it('runs chat specialists in the active workspace even when background delegation is available', async () => {
  const onDelegate = vi.fn(async () => ({ ok: true, detail: 'queued', childJobId: 'background' }))
  harness.replies.push(
    JSON.stringify({ name: 'search_tools', query: 'delegate_to_agent' }),
    JSON.stringify({
      name: 'delegate_to_agent',
      agent_id: 'coder',
      goal: 'Edit src/retry.ts to set MAX_RETRIES to 4. Verify the change.',
      summary: 'The user wants four retries.',
      files: ['src/retry.ts']
    }),
    JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
    JSON.stringify({
      name: 'search_replace',
      path: 'src/retry.ts',
      old_string: 'MAX_RETRIES = 3',
      new_string: 'MAX_RETRIES = 4'
    }),
    'DONE: Changed MAX_RETRIES to 4 in src/retry.ts; verification passed.',
    'DONE: Changed MAX_RETRIES to 4 in src/retry.ts; verification passed.'
  )
  const events = await drain(
    runAgentWithWorkspaceTools({
      workspacePath,
      settings: getDefaults(),
      model: 'builtin:composer-lite',
      messages: [{ role: 'user', content: 'Set MAX_RETRIES to 4 in src/retry.ts.' }],
      temperature: 0,
      getSecret: () => null,
      mode: 'agent',
      turnPlan: fullEditPlan(),
      mcp: 'off',
      jobId: 'chat:delegation-regression',
      onDelegate
    })
  )
  expect(onDelegate).not.toHaveBeenCalled()
  expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 4')
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'delegation',
        delegation: expect.objectContaining({ status: 'done' })
      }),
      expect.objectContaining({
        type: 'diff',
        diff: expect.objectContaining({ path: 'src/retry.ts' })
      })
    ])
  )
  expect(harness.verifyCalls).toBeGreaterThan(0)
  expectCompleted(events)
})

it('does not inspect or edit an unrelated project when the named site is absent', async () => {
  const events = await drain(
    runAgentWithWorkspaceTools({
      workspacePath,
      settings: getDefaults(),
      model: 'builtin:composer-lite',
      messages: [{ role: 'user', content: 'Review the code, improve it for the AirBNB website' }],
      temperature: 0,
      getSecret: () => null,
      mode: 'agent',
      turnPlan: fullEditPlan(),
      mcp: 'off'
    })
  )
  expect(lastAnswer(events)).toContain("couldn't identify the requested project")
  expect(toolsFrom(events)).toHaveLength(0)
  expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 3')
})

it('blocks a model write to another project when the named site is present', async () => {
  mkdirSync(join(workspacePath, 'airbnb-clone'))
  harness.replies.push(
    JSON.stringify({ name: 'write_file', path: 'src/retry.ts', content: 'wrong project' }),
    'DONE: Updated the site.'
  )
  const settings = structuredClone(getDefaults())
  settings.agent.maxStepsPerRun = 2
  const events = await drain(
    runAgentWithWorkspaceTools({
      workspacePath,
      settings,
      model: 'builtin:composer-lite',
      messages: [{ role: 'user', content: 'Improve it for the AirBNB website' }],
      temperature: 0,
      getSecret: () => null,
      mode: 'agent',
      turnPlan: fullEditPlan(),
      mcp: 'off'
    })
  )
  expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 3')
  expect(toolsFrom(events)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'write_file',
        status: 'error',
        detail: expect.stringContaining('another project')
      })
    ])
  )
})

it('replays native call IDs and tool results through a real read-edit-verify loop', async () => {
  harness.nativeCalls.push(
    [{ id: 'native-read', name: 'read_file', arguments: JSON.stringify({ path: 'src/retry.ts' }) }],
    [
      {
        id: 'native-edit',
        name: 'search_replace',
        arguments: JSON.stringify({
          path: 'src/retry.ts',
          old_string: 'MAX_RETRIES = 3',
          new_string: 'MAX_RETRIES = 5'
        })
      }
    ]
  )
  harness.replies.push(
    '',
    '',
    'DONE: Changed src/retry.ts to five retries and verification passed.'
  )
  const plan = fullEditPlan()
  plan.models = { chat: 'api:test', tools: 'api:test' }
  const events = await drain(
    runAgentWithWorkspaceTools({
      workspacePath,
      settings: getDefaults(),
      model: 'api:test',
      messages: [{ role: 'user', content: 'Set MAX_RETRIES to 5 in src/retry.ts' }],
      temperature: 0,
      getSecret: () => null,
      mode: 'agent',
      turnPlan: plan,
      mcp: 'off'
    })
  )
  expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 5')
  expect(harness.transcripts[1]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: expect.arrayContaining([expect.objectContaining({ id: 'native-read' })])
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'native-read',
        content: expect.stringContaining('MAX_RETRIES = 3')
      })
    ])
  )
  expect(events.filter((event) => event.type === 'progress' && event.incomplete)).toEqual([])
  expectCompleted(events)
})

it('requires fresh verification after a later source edit', async () => {
  for (const [before, after] of Array.from({ length: 9 }, (_, index) => [index + 3, index + 4]))
    harness.replies.push(
      JSON.stringify({ name: 'read_file', path: 'src/retry.ts' }),
      JSON.stringify({
        name: 'search_replace',
        path: 'src/retry.ts',
        old_string: `MAX_RETRIES = ${before}`,
        new_string: `MAX_RETRIES = ${after}`
      })
    )
  harness.replies.push('DONE: Updated src/retry.ts to twelve retries and verified the final code.')
  const events = await drain(
    runAgentWithWorkspaceTools({
      workspacePath,
      settings: getDefaults(),
      model: 'builtin:composer-lite',
      messages: [{ role: 'user', content: 'Set MAX_RETRIES to 6 in src/retry.ts' }],
      temperature: 0,
      getSecret: () => null,
      mode: 'agent',
      turnPlan: fullEditPlan(),
      mcp: 'off'
    })
  )
  expect(readFileSync(join(workspacePath, 'src/retry.ts'), 'utf8')).toContain('MAX_RETRIES = 12')
  expect(harness.verifyCalls).toBe(2)
  expectCompleted(events)
})
