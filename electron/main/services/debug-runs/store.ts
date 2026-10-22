import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type {
  DebugCaseResult,
  DebugRecordedResponse,
  DebugRunDetail,
  DebugRunSummary
} from '../../../../src/shared/debug-runs'
import { userDataRoot } from '../paths'

/** Local-only run history: summary JSON, append-only case JSONL, optional replies JSONL. */
const MAX_RUNS = 30
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,120}$/

export function debugRunsDir(): string {
  return join(userDataRoot(), 'debug-runs')
}

export function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error('Invalid diagnostics run id')
  return runId
}

function file(runId: string, suffix: 'summary.json' | 'cases.jsonl' | 'responses.jsonl'): string {
  return join(debugRunsDir(), `${assertRunId(runId)}.${suffix}`)
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

export function writeRunSummary(summary: DebugRunSummary): void {
  mkdirSync(debugRunsDir(), { recursive: true })
  writeFileSync(file(summary.runId, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
}

export function appendCaseResult(result: DebugCaseResult): void {
  appendFileSync(file(result.runId, 'cases.jsonl'), `${JSON.stringify(result)}\n`, 'utf8')
}

export function appendRecordedResponses(runId: string, responses: DebugRecordedResponse[]): void {
  if (!responses.length) return
  appendFileSync(
    file(runId, 'responses.jsonl'),
    responses.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'utf8'
  )
}

export function listDebugRunSummaries(): DebugRunSummary[] {
  if (!existsSync(debugRunsDir())) return []
  return readdirSync(debugRunsDir())
    .filter((name) => name.endsWith('.summary.json'))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(debugRunsDir(), name), 'utf8')) as DebugRunSummary]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function readDebugRun(runId: string): DebugRunDetail | null {
  const path = file(runId, 'summary.json')
  if (!existsSync(path)) return null
  const summary = JSON.parse(readFileSync(path, 'utf8')) as DebugRunSummary
  return {
    summary,
    cases: readJsonl<DebugCaseResult>(file(runId, 'cases.jsonl')),
    responses: readJsonl<DebugRecordedResponse>(file(runId, 'responses.jsonl'))
  }
}

export function deleteDebugRun(runId: string): boolean {
  let removed = false
  for (const suffix of ['summary.json', 'cases.jsonl', 'responses.jsonl'] as const) {
    const path = file(runId, suffix)
    if (existsSync(path)) {
      rmSync(path, { force: true })
      removed = true
    }
  }
  return removed
}

export function deleteAllDebugRuns(): number {
  const runs = listDebugRunSummaries().filter((run) => run.status !== 'running')
  for (const run of runs) deleteDebugRun(run.runId)
  return runs.length
}

/** Keep the newest finished runs; never prune a run that is still active. */
export function pruneDebugRuns(keep = MAX_RUNS): void {
  const finished = listDebugRunSummaries().filter((run) => run.status !== 'running')
  for (const run of finished.slice(keep)) deleteDebugRun(run.runId)
}
