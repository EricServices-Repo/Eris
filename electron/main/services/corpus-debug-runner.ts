import { randomUUID } from 'crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import type { AppSettings, ChatIntent } from '../../../src/shared/settings-schema'
import {
  CORPUS_RUN_COVERAGE,
  type CorpusDebugProgressEvent,
  type CorpusDebugQuestionResult,
  type CorpusDebugRunRequest,
  type CorpusDebugRunSummary,
  type EvalCheck,
  type EvalTask
} from '../../../src/shared/evals'
import { appResourcePath, userDataRoot } from './paths'
import { planChatTurn } from './chat-router'
import { runEvalTask } from './eval-runner'
import { logError, logInfo } from './logger'

type ProgressFn = (event: CorpusDebugProgressEvent) => void
type Question = { id: string; text: string }

const TOTAL_QUESTIONS = 10_000
const MAX_QUESTIONS_PER_RUN = TOTAL_QUESTIONS
let runningAbort: AbortController | null = null

function runsDir(): string {
  return join(userDataRoot(), 'evals', 'corpus-debug')
}

function summaryPath(runId: string): string {
  return join(runsDir(), `${runId}.summary.json`)
}

function safeId(model: string): string {
  return (
    model
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'model'
  )
}

function loadCorpus(): Question[] {
  const path = appResourcePath('evals/10000-natural-diverse-coding-questions.txt')
  const questions = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^(\d+)\.\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => ({ id: match[1]!, text: match[2]!.trim() }))
  if (questions.length !== TOTAL_QUESTIONS) {
    throw new Error(`Expected ${TOTAL_QUESTIONS} corpus questions, found ${questions.length}`)
  }
  return questions
}

function fixtureFiles(): Record<string, string> {
  return {
    'README.md': [
      '# Eris model smoke-test sandbox',
      '',
      'This disposable TypeScript workspace exists only for agent evaluation.',
      'Inspect or edit its files when the request requires code changes.'
    ].join('\n'),
    'package.json': JSON.stringify(
      {
        name: 'eris-corpus-smoke-sandbox',
        private: true,
        scripts: { test: 'node verify.cjs', verify: 'node verify.cjs' }
      },
      null,
      2
    ),
    'verify.cjs':
      "const fs = require('fs'); if (!fs.existsSync('src/catalog.ts')) process.exit(1); console.log('sandbox verification passed')\n",
    'src/catalog.ts': [
      'export type CatalogItem = { id: string; name: string; enabled: boolean }',
      '',
      'export const catalog: CatalogItem[] = [',
      "  { id: 'alpha', name: 'Alpha', enabled: true },",
      "  { id: 'beta', name: 'Beta', enabled: false }",
      ']',
      '',
      'export function findCatalogItem(id: string): CatalogItem | undefined {',
      '  return catalog.find((item) => item.id === id)',
      '}',
      ''
    ].join('\n')
  }
}

function checksFor(intent: ChatIntent): EvalCheck[] {
  const checks: EvalCheck[] = [
    { type: 'answer_matches', pattern: '\\S' },
    { type: 'max_tool_errors', value: 0 }
  ]
  if (intent === 'edit') checks.push({ type: 'has_changes' })
  else checks.push({ type: 'no_changes' })
  return checks
}

function writeSummary(summary: CorpusDebugRunSummary): void {
  mkdirSync(runsDir(), { recursive: true })
  writeFileSync(summaryPath(summary.runId), JSON.stringify(summary, null, 2), 'utf8')
}

function readResults(path: string): CorpusDebugQuestionResult[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CorpusDebugQuestionResult]
      } catch {
        return []
      }
    })
}

function renderReview(summary: CorpusDebugRunSummary): string {
  const results = readResults(summary.jsonlPath)
  const failures = results.filter((item) => !item.result.ok)
  const byIntent = new Map<string, { total: number; passed: number }>()
  for (const item of results) {
    const bucket = byIntent.get(item.plannedIntent) ?? { total: 0, passed: 0 }
    bucket.total += 1
    if (item.result.ok) bucket.passed += 1
    byIntent.set(item.plannedIntent, bucket)
  }
  const lines = [
    '# Eris real-model corpus review',
    '',
    `- Mode: ${CORPUS_RUN_COVERAGE.label} (live calls to the selected model)`,
    `- Path: ${CORPUS_RUN_COVERAGE.path}`,
    `- Oracle: ${CORPUS_RUN_COVERAGE.oracle}`,
    `- Run: \`${summary.runId}\``,
    `- Model: \`${summary.model}\``,
    `- Status: ${summary.status}`,
    `- Corpus range: ${summary.startIndex + 1}–${Math.max(summary.startIndex, summary.nextIndex - 1) + 1} of ${summary.totalCorpus}`,
    `- Passed: ${summary.passed}/${summary.completed}`,
    `- Failed: ${summary.failed}`,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt ?? 'in progress'}`,
    `- Raw JSONL: \`${basename(summary.jsonlPath)}\``,
    '',
    '## Results by routed intent',
    '',
    '| Intent | Passed | Total | Rate |',
    '| --- | ---: | ---: | ---: |',
    ...[...byIntent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([intent, value]) =>
          `| ${intent} | ${value.passed} | ${value.total} | ${Math.round((value.passed / value.total) * 100)}% |`
      ),
    '',
    '## Failures',
    ''
  ]
  if (!failures.length) lines.push('No failures recorded.')
  for (const item of failures.slice(0, 200)) {
    lines.push(
      `### ${item.questionId}: ${item.plannedIntent} · ${item.plannedAgentId}`,
      '',
      item.question,
      '',
      `- Error: ${item.result.error ?? 'check failure'}${item.result.status ? ` (${item.result.status})` : ''}`,
      `- Routed models: chat \`${item.plannedChatModel}\`, tools \`${item.plannedToolsModel}\``,
      `- Checks: ${item.result.checks.map((check) => `${check.ok ? 'pass' : 'fail'} ${check.detail}`).join('; ') || 'none'}`,
      `- Steps/tools/errors: ${item.result.steps}/${item.result.toolCalls}/${item.result.toolErrors}`,
      '',
      '```text',
      item.result.answer.slice(0, 2000).replace(/```/g, "'''"),
      '```',
      ''
    )
  }
  if (failures.length > 200)
    lines.push(`_${failures.length - 200} more failures are available in the JSONL file._`, '')
  return lines.join('\n')
}

function persistReview(summary: CorpusDebugRunSummary): void {
  writeSummary(summary)
  writeFileSync(summary.reviewPath, renderReview(summary), 'utf8')
}

export function isCorpusDebugRunActive(): boolean {
  return Boolean(runningAbort && !runningAbort.signal.aborted)
}

export function cancelCorpusDebugRun(): boolean {
  if (!runningAbort) return false
  runningAbort.abort()
  return true
}

export function listCorpusDebugRuns(): CorpusDebugRunSummary[] {
  if (!existsSync(runsDir())) return []
  return readdirSync(runsDir())
    .filter((name) => name.endsWith('.summary.json'))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(runsDir(), name), 'utf8')) as CorpusDebugRunSummary]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function copyCorpusDebugReport(runId: string, destination: string): void {
  const summary = listCorpusDebugRuns().find((run) => run.runId === runId)
  if (!summary) throw new Error('Corpus debug report not found')
  writeFileSync(summary.reviewPath, renderReview(summary), 'utf8')
  copyFileSync(summary.reviewPath, destination)
}

export async function runCorpusDebug(
  workspacePath: string | null,
  settings: AppSettings,
  request: CorpusDebugRunRequest,
  getSecret: (key: string) => string | null,
  onProgress?: ProgressFn
): Promise<CorpusDebugRunSummary> {
  if (runningAbort) throw new Error('A real-model corpus run is already in progress')
  if (!request.model.trim()) throw new Error('Select a model before starting the corpus run')
  const questions = loadCorpus()
  const startIndex = Math.max(
    0,
    Math.min(questions.length - 1, Math.floor(request.startIndex || 0))
  )
  const count = Math.max(
    1,
    Math.min(MAX_QUESTIONS_PER_RUN, Math.floor(request.count || 25), questions.length - startIndex)
  )
  const chunkSize = Math.max(1, Math.min(100, Math.floor(request.chunkSize || 10)))
  const maxSteps = Math.max(10, Math.min(200, Math.floor(request.maxSteps || 20)))
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeId(request.model)}-${randomUUID().slice(0, 8)}`
  mkdirSync(runsDir(), { recursive: true })
  const jsonlPath = join(runsDir(), `${runId}.jsonl`)
  const reviewPath = join(runsDir(), `${runId}.review.md`)
  const summary: CorpusDebugRunSummary = {
    runId,
    mode: 'real-model',
    model: request.model,
    status: 'running',
    startIndex,
    requested: count,
    completed: 0,
    passed: 0,
    failed: 0,
    nextIndex: startIndex,
    totalCorpus: questions.length,
    chunkSize,
    maxSteps,
    startedAt: new Date().toISOString(),
    jsonlPath,
    reviewPath
  }
  const ac = new AbortController()
  runningAbort = ac
  writeSummary(summary)
  onProgress?.({ type: 'start', summary: { ...summary } })
  const evalSettings: AppSettings = {
    ...settings,
    agent: { ...settings.agent, maxStepsPerRun: maxSteps }
  }
  try {
    for (let offset = 0; offset < count; offset++) {
      if (ac.signal.aborted) break
      const index = startIndex + offset
      const question = questions[index]!
      onProgress?.({
        type: 'question-start',
        runId,
        index,
        questionId: question.id,
        question: question.text
      })
      const plan = await planChatTurn({
        workspacePath,
        settings: evalSettings,
        context: {
          text: question.text,
          fileNames: ['README.md', 'package.json', 'src/catalog.ts'],
          selectedModel: request.model,
          mode: 'agent'
        },
        getSecret,
        signal: ac.signal
      })
      const task: EvalTask = {
        id: `corpus-${question.id}`,
        title: `Natural coding question ${question.id}`,
        intent: plan.intent,
        prompt: question.text,
        files: fixtureFiles(),
        checks: checksFor(plan.intent),
        agentId: plan.agentId,
        mode: plan.mode,
        timeoutMs: 1_800_000
      }
      const result = await runEvalTask({
        task,
        source: 'builtin',
        model: request.model,
        settings: evalSettings,
        getSecret,
        signal: ac.signal,
        turnPlan: plan,
        onStatus: (text) => onProgress?.({ type: 'status', runId, index, text })
      })
      result.batchId = runId
      const item: CorpusDebugQuestionResult = {
        index,
        questionId: question.id,
        question: question.text,
        plannedIntent: plan.intent,
        plannedAgentId: plan.agentId,
        plannedChatModel: plan.models.chat,
        plannedToolsModel: plan.models.tools,
        routeMethod: plan.method,
        result
      }
      appendFileSync(jsonlPath, `${JSON.stringify(item)}\n`, 'utf8')
      summary.completed += 1
      summary.nextIndex = index + 1
      if (result.ok) summary.passed += 1
      else summary.failed += 1
      onProgress?.({ type: 'result', runId, item, summary: { ...summary } })
      if (summary.completed % chunkSize === 0) {
        // Keep checkpoints cheap for long runs. The complete Markdown report is
        // generated at the end or on export from the append-only JSONL file.
        writeSummary(summary)
        onProgress?.({ type: 'chunk-saved', runId, summary: { ...summary } })
      }
    }
    summary.status = ac.signal.aborted ? 'cancelled' : 'completed'
  } catch (error) {
    summary.status = ac.signal.aborted ? 'cancelled' : 'failed'
    summary.error = error instanceof Error ? error.message : String(error)
    logError('Real-model corpus run failed', { runId, error: summary.error })
  } finally {
    summary.finishedAt = new Date().toISOString()
    persistReview(summary)
    runningAbort = null
    onProgress?.({ type: 'done', summary: { ...summary } })
  }
  logInfo('Real-model corpus run finished', {
    runId,
    status: summary.status,
    passed: summary.passed,
    completed: summary.completed
  })
  return summary
}
