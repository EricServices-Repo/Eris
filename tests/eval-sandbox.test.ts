/* eslint-disable require-yield -- fake agents only need to hang or ignore their signal */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvalTask } from '../src/shared/evals'

/** Eval fixture/check paths stay inside the sandbox; task deadlines differ from cancellation. */
const agent = vi.hoisted(() => ({
  run: async function* () {} as (options: { signal?: AbortSignal }) => AsyncGenerator<unknown>
}))
vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: (options: { signal?: AbortSignal }) => agent.run(options)
}))

const { EvalCheckSchema, EvalTaskSchema } = await import('../src/shared/evals')
const { evaluateChecks, materializeEvalTask, runEvalTask } =
  await import('../electron/main/services/eval-runner')
const { resolveSandboxPath, SandboxPathError } =
  await import('../electron/main/services/sandbox-paths')
const { loadWorkspaceEvalTasks } = await import('../electron/main/services/eval-tasks')
const { createTaskDeadline, drainUntilStopped } =
  await import('../electron/main/services/task-deadline')
const { getDefaults } = await import('../electron/main/services/settings')

const UNSAFE = [
  '../../escape.txt',
  'src/../../escape.txt',
  '/etc/passwd',
  '\\windows\\system32',
  'C:\\Windows\\x.txt',
  'c:relative.txt',
  'src\\..\\..\\escape.txt',
  'a\0b',
  ''
]

function task(patch: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'sandbox-task',
    title: 'Sandbox task',
    intent: 'edit',
    prompt: 'do it',
    files: { 'src/a.ts': 'export const a = 1\n' },
    checks: [{ type: 'file_exists', path: 'src/a.ts' }],
    mode: 'agent',
    timeoutMs: 1_000,
    ...patch
  }
}

function evalTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('eris-eval-sandbox-task-'))
}

beforeEach(() => {
  agent.run = async function* () {}
})

describe('eval path containment', () => {
  it('rejects unsafe fixture and check paths at schema ingestion', () => {
    for (const path of UNSAFE) {
      expect(EvalTaskSchema.safeParse({ ...task(), files: { [path]: 'x' } }).success).toBe(false)
      expect(EvalCheckSchema.safeParse({ type: 'file_exists', path }).success).toBe(false)
    }
    expect(EvalTaskSchema.safeParse(task({ files: { 'src/nested/x.ts': 'x' } })).success).toBe(true)
  })

  it('validates every fixture path before writing any of them', () => {
    const dest = mkdtempSync(join(tmpdir(), 'eris-eval-mat-'))
    const outside = join(dest, '..', `escape-${Date.now()}.txt`)
    expect(() =>
      materializeEvalTask(
        task({ files: { 'first.txt': 'ok', '../escape.txt': 'x', 'last.txt': 'ok' } }),
        dest
      )
    ).toThrow(SandboxPathError)
    expect(readdirSync(dest)).toEqual([])
    expect(existsSync(outside)).toBe(false)
  })

  it('follows real paths so a symlink cannot redirect reads or writes', () => {
    const dest = mkdtempSync(join(tmpdir(), 'eris-eval-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'eris-eval-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(dest, 'link'))
    expect(() => resolveSandboxPath(dest, 'link/secret.txt')).toThrow(/symlink escapes/)
    expect(() => resolveSandboxPath(dest, 'link/new.txt')).toThrow(/symlink escapes/)
    expect(() => materializeEvalTask(task({ files: { 'link/new.txt': 'x' } }), dest)).toThrow()
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    const [result] = evaluateChecks(dest, [{ type: 'file_exists', path: 'link/secret.txt' }], {
      answer: '',
      snapshot: {},
      files: {}
    })
    expect(result!.ok).toBe(false)
    expect(result!.detail).toMatch(/Unsafe sandbox path/)
    mkdirSync(join(dest, 'src'))
    expect(resolveSandboxPath(dest, 'src/ok.ts')).toBe(join(realpathSync(dest), 'src', 'ok.ts'))
  })

  it('keeps unsafe workspace eval definitions out of the run list and says why', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'eris-eval-ws-'))
    mkdirSync(join(workspace, '.eris'), { recursive: true })
    writeFileSync(
      join(workspace, '.eris', 'evals.json'),
      JSON.stringify([
        { ...task(), id: 'valid-task' },
        { ...task(), id: 'escape-task', files: { '../../outside.txt': 'x' } }
      ])
    )
    const loaded = loadWorkspaceEvalTasks(workspace)
    expect(loaded.tasks.map((item) => item.id)).toEqual(['valid-task'])
    expect(loaded.rejected).toEqual([
      expect.objectContaining({
        file: '.eris/evals.json',
        id: 'escape-task',
        error: expect.stringContaining('parent-directory traversal')
      })
    ])
  })
})

describe('eval task lifecycle', () => {
  it('ends a non-terminating agent at its timeout with a stable timed_out category', async () => {
    agent.run = async function* (options) {
      await new Promise((_, reject) =>
        options.signal?.addEventListener('abort', () => {
          const error = new Error('Aborted')
          error.name = 'AbortError'
          reject(error)
        })
      )
    }
    const started = Date.now()
    const result = await runEvalTask({
      task: task({ timeoutMs: 150 }),
      source: 'builtin',
      model: 'm',
      settings: getDefaults(),
      getSecret: () => null
    })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result.status).toBe('timed_out')
    expect(result.failureCategory).toBe('timed_out')
    expect(result.error).toBe('Timed out after 150ms')
    expect(evalTempDirs()).toEqual([])
  })

  it('ends an agent that ignores its abort signal at the deadline', async () => {
    agent.run = async function* () {
      await new Promise(() => undefined)
    }
    const started = Date.now()
    const result = await runEvalTask({
      task: task({ timeoutMs: 120 }),
      source: 'builtin',
      model: 'm',
      settings: getDefaults(),
      getSecret: () => null
    })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result.status).toBe('timed_out')
  })

  it('reports user cancellation separately from timeout', async () => {
    agent.run = async function* () {
      await new Promise(() => undefined)
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await runEvalTask({
      task: task({ timeoutMs: 60_000 }),
      source: 'builtin',
      model: 'm',
      settings: getDefaults(),
      getSecret: () => null,
      signal: controller.signal
    })
    expect(result.status).toBe('cancelled')
    expect(result.failureCategory).toBe('user_cancelled')
    expect(result.error).toBe('Cancelled')
  })

  it('records passed/failed checks with a terminal status', async () => {
    const passed = await runEvalTask({
      task: task(),
      source: 'builtin',
      model: 'm',
      settings: getDefaults(),
      getSecret: () => null
    })
    expect(passed).toMatchObject({ ok: true, status: 'passed' })
    const failed = await runEvalTask({
      task: task({ checks: [{ type: 'file_exists', path: 'missing.ts' }] }),
      source: 'builtin',
      model: 'm',
      settings: getDefaults(),
      getSecret: () => null
    })
    expect(failed).toMatchObject({ ok: false, status: 'failed', failureCategory: 'check_failed' })
  })

  it('rejects an unsafe task that bypassed schema validation without running the agent', async () => {
    let ran = false
    agent.run = async function* () {
      ran = true
    }
    const result = await runEvalTask({
      task: task({ files: { '../escape.txt': 'x' } }),
      source: 'workspace',
      model: 'm',
      settings: getDefaults(),
      getSecret: () => null
    })
    expect(ran).toBe(false)
    expect(result).toMatchObject({ status: 'error', failureCategory: 'fixture_invalid' })
  })

  it('task deadlines distinguish the first stop reason and clean up their timer', async () => {
    const parent = new AbortController()
    const deadline = createTaskDeadline(parent.signal, 60_000)
    parent.abort()
    expect(deadline.stopReason()).toBe('cancelled')
    deadline.dispose()
    const timed = createTaskDeadline(undefined, 20)
    const ended = await drainUntilStopped(
      (async function* () {
        await new Promise(() => undefined)
      })(),
      timed,
      () => undefined
    )
    expect(ended).toBe('timeout')
    timed.dispose()
  })
})
