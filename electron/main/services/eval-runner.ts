import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AppSettings } from '../../../src/shared/settings-schema'
import type {
  EvalCheck,
  EvalCheckResult,
  EvalProgressEvent,
  EvalResult,
  EvalRunRequest,
  EvalTask
} from '../../../src/shared/evals'
import { runAgentWithWorkspaceTools } from './agent-runner'
import { runWorkspaceCommand } from './shell-run'
import { appendEvalResults } from './eval-store'
import { findEvalTask, taskSourceLabel } from './eval-tasks'
import { logError, logInfo } from './logger'

export type EvalProgressFn = (event: EvalProgressEvent) => void

let runningAbort: AbortController | null = null

export function isEvalRunActive(): boolean {
  return Boolean(runningAbort && !runningAbort.signal.aborted)
}

export function cancelEvalRun(): boolean {
  if (!runningAbort) return false
  runningAbort.abort()
  return true
}

export function materializeEvalTask(task: EvalTask, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const [rel, content] of Object.entries(task.files)) {
    const abs = join(dest, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
}

function snapshotFiles(root: string, files: Record<string, string>): Record<string, string | null> {
  const snap: Record<string, string | null> = {}
  for (const rel of Object.keys(files)) {
    const abs = join(root, rel)
    snap[rel] = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  }
  return snap
}

export function evaluateChecks(
  workspacePath: string,
  checks: EvalCheck[],
  ctx: { answer: string; snapshot: Record<string, string | null>; files: Record<string, string> }
): EvalCheckResult[] {
  return checks.map((check) => runCheck(workspacePath, check, ctx))
}

function runCheck(
  workspacePath: string,
  check: EvalCheck,
  ctx: { answer: string; snapshot: Record<string, string | null>; files: Record<string, string> }
): EvalCheckResult {
  try {
    switch (check.type) {
      case 'file_contains': {
        const abs = join(workspacePath, check.path)
        if (!existsSync(abs)) return fail(check, `missing ${check.path}`)
        const body = readFileSync(abs, 'utf8')
        return body.includes(check.text)
          ? pass(check, `found in ${check.path}`)
          : fail(check, `“${check.text.slice(0, 80)}” not in ${check.path}`)
      }
      case 'file_matches': {
        const abs = join(workspacePath, check.path)
        if (!existsSync(abs)) return fail(check, `missing ${check.path}`)
        const re = new RegExp(check.pattern, 'm')
        return re.test(readFileSync(abs, 'utf8'))
          ? pass(check, `matched ${check.path}`)
          : fail(check, `/${check.pattern}/ not in ${check.path}`)
      }
      case 'file_exists':
        return existsSync(join(workspacePath, check.path))
          ? pass(check, check.path)
          : fail(check, `missing ${check.path}`)
      case 'file_absent':
        return existsSync(join(workspacePath, check.path))
          ? fail(check, `still present: ${check.path}`)
          : pass(check, `absent ${check.path}`)
      case 'answer_contains':
        return ctx.answer.toLowerCase().includes(check.text.toLowerCase())
          ? pass(check, 'answer contains text')
          : fail(check, `answer missing “${check.text.slice(0, 80)}”`)
      case 'answer_matches': {
        const re = new RegExp(check.pattern, 'i')
        return re.test(ctx.answer)
          ? pass(check, 'answer matched')
          : fail(check, `answer did not match /${check.pattern}/`)
      }
      case 'no_changes': {
        for (const [rel, before] of Object.entries(ctx.snapshot)) {
          const abs = join(workspacePath, rel)
          const after = existsSync(abs) ? readFileSync(abs, 'utf8') : null
          if (after !== before) return fail(check, `changed ${rel}`)
        }
        return pass(check, 'fixtures unchanged')
      }
      case 'command': {
        // Sync-looking API; the runner awaits this via a Promise wrapper below.
        return { check, ok: false, detail: 'command checks are async' }
      }
      default:
        return fail(check, 'unknown check')
    }
  } catch (err) {
    return fail(check, err instanceof Error ? err.message : String(err))
  }
}

function pass(check: EvalCheck, detail: string): EvalCheckResult {
  return { check, ok: true, detail }
}

function fail(check: EvalCheck, detail: string): EvalCheckResult {
  return { check, ok: false, detail }
}

async function evaluateChecksAsync(
  workspacePath: string,
  checks: EvalCheck[],
  ctx: { answer: string; snapshot: Record<string, string | null>; files: Record<string, string> },
  signal?: AbortSignal
): Promise<EvalCheckResult[]> {
  const out: EvalCheckResult[] = []
  for (const check of checks) {
    if (check.type === 'command') {
      const ran = await runWorkspaceCommand(workspacePath, check.command, {
        signal,
        timeoutMs: 60_000
      })
      const expect = check.expectExit ?? 0
      const code = ran.code ?? 1
      out.push(
        code === expect && !ran.timedOut
          ? pass(check, `exit ${code}`)
          : fail(check, ran.stderr || ran.stdout || `exit ${code}${ran.timedOut ? ' (timeout)' : ''}`)
      )
      continue
    }
    out.push(runCheck(workspacePath, check, ctx))
  }
  return out
}

export async function runEvalTask(options: {
  task: EvalTask
  source: 'builtin' | 'workspace'
  model: string
  settings: AppSettings
  getSecret: (key: string) => string | null
  signal?: AbortSignal
  onStatus?: (text: string) => void
}): Promise<EvalResult> {
  const started = Date.now()
  const dest = mkdtempSync(join(tmpdir(), `eris-eval-${options.task.id}-`))
  materializeEvalTask(options.task, dest)
  const snapshot = snapshotFiles(dest, options.task.files)
  let answer = ''
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  const agentId = options.task.agentId || options.settings.agent.routing.fallbackAgentId || 'composer'
  const allowUnsafe = options.settings.evals.allowUnsafeCommands
  try {
    options.onStatus?.(`Running ${options.task.id} on ${options.model}`)
    for await (const evt of runAgentWithWorkspaceTools({
      workspacePath: dest,
      settings: options.settings,
      model: options.model,
      messages: [
        { role: 'user', content: options.task.prompt }
      ],
      temperature: options.settings.models.temperature,
      signal: options.signal,
      getSecret: options.getSecret,
      mode: options.task.mode,
      mcp: 'off',
      approveCommand: async (kind, command) => {
        if (allowUnsafe) return true
        if (kind === 'run' && /node(\s|$)|npm test|npm run test/i.test(command)) return true
        return false
      }
    })) {
      if (evt.type === 'answer') answer += evt.text
      else if (evt.type === 'progress') steps = evt.step
      else if (evt.type === 'tool') {
        toolCalls += 1
        if (evt.tool.status === 'error') toolErrors += 1
        options.onStatus?.(`${evt.tool.name}: ${evt.tool.status}`)
      } else if (evt.type === 'status') {
        options.onStatus?.(evt.text)
      }
    }
    const checks = await evaluateChecksAsync(
      dest,
      options.task.checks,
      { answer, snapshot, files: options.task.files },
      options.signal
    )
    const ok = checks.every((c) => c.ok)
    return {
      batchId: '',
      taskId: options.task.id,
      taskTitle: options.task.title,
      source: options.source,
      intent: options.task.intent,
      model: options.model,
      agentId,
      ok,
      checks,
      steps,
      toolCalls,
      toolErrors,
      durationMs: Date.now() - started,
      answer: answer.slice(0, 4000),
      at: new Date().toISOString()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      batchId: '',
      taskId: options.task.id,
      taskTitle: options.task.title,
      source: options.source,
      intent: options.task.intent,
      model: options.model,
      agentId,
      ok: false,
      checks: [],
      steps,
      toolCalls,
      toolErrors,
      durationMs: Date.now() - started,
      answer: answer.slice(0, 4000),
      error: aborted ? 'Cancelled' : message,
      at: new Date().toISOString()
    }
  } finally {
    try {
      rmSync(dest, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

export async function runEvalSuite(
  workspacePath: string | null,
  settings: AppSettings,
  request: EvalRunRequest,
  getSecret: (key: string) => string | null,
  onProgress?: EvalProgressFn
): Promise<EvalResult[]> {
  if (runningAbort) throw new Error('An eval run is already in progress')
  const ac = new AbortController()
  runningAbort = ac
  const batchId = randomUUID()
  const models = request.models.filter(Boolean)
  const repeats = Math.max(1, Math.min(5, request.repeats || 1))
  const jobs: Array<{ task: EvalTask; source: 'builtin' | 'workspace'; model: string }> = []
  for (const id of request.taskIds) {
    const task = findEvalTask(workspacePath, id)
    if (!task) continue
    const source = taskSourceLabel(id, workspacePath)
    for (const model of models) {
      for (let i = 0; i < repeats; i++) jobs.push({ task, source, model })
    }
  }
  onProgress?.({ type: 'start', batchId, total: jobs.length })
  const results: EvalResult[] = []
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (ac.signal.aborted) break
      const job = jobs[i]!
      onProgress?.({
        type: 'task-start',
        batchId,
        index: i,
        taskId: job.task.id,
        model: job.model
      })
      const result = await runEvalTask({
        task: job.task,
        source: job.source,
        model: job.model,
        settings,
        getSecret,
        signal: ac.signal,
        onStatus: (text) =>
          onProgress?.({ type: 'task-status', batchId, taskId: job.task.id, model: job.model, text })
      })
      result.batchId = batchId
      results.push(result)
      onProgress?.({ type: 'result', batchId, index: i, result })
    }
    appendEvalResults(results)
    onProgress?.({
      type: 'done',
      batchId,
      passed: results.filter((r) => r.ok).length,
      total: results.length,
      cancelled: ac.signal.aborted
    })
    logInfo('Eval suite finished', {
      batchId,
      passed: results.filter((r) => r.ok).length,
      total: results.length
    })
    return results
  } catch (err) {
    logError('Eval suite failed', { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    runningAbort = null
  }
}
