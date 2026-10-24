import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Stage 6 of docs/reviews/eris-dev-10000-2026-10-23/improvements.json:
 * grading, evidence for claims, outcome taxonomy, coverage, export redaction,
 * resumable runs and run comparison (AG-069–085).
 */

import { gradeCodeExample } from '../src/shared/code-grading'
import { rubricForTopic, TOPIC_RUBRICS } from '../src/shared/topic-rubrics'
import { evaluateScenario, type OracleInput } from '../electron/main/services/debug-runs/oracle'
import {
  caseOutcome,
  coverageOf,
  evaluationOf,
  outcomeClass
} from '../electron/main/services/debug-runs/evaluation'
import { builtinDebugScenarios } from '../electron/main/services/debug-runs/scenarios'
import { CaptureSanitizer } from '../electron/dev/sanitize'
import {
  listRuns,
  markInterruptedRuns,
  readProgress,
  resumeConflicts,
  resumePoint,
  writeManifest,
  writeProgress,
  type RunManifest
} from '../electron/dev/runs'
import { compareCaptures } from '../src/shared/eris-dev-compare'
import { prepareQuestions } from '../electron/dev/questions'
import { readCaptureRecord, type DevResult, type DevRunHeader } from '../src/shared/eris-dev'
import { stripToolBlocks } from '../electron/main/services/agent/tool-parsing'
import { isReadOnlyChat } from '../electron/main/services/agent/prompts'
import type { DebugCaseResult, DebugScenario } from '../src/shared/debug-runs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const tempDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'eris-qualify-'))
  roots.push(root)
  return root
}

const SOFT_DELETE = [
  '```ts',
  'interface Row { id: string; deletedAt: Date | null }',
  'export function softDelete(row: Row) { row.deletedAt = new Date() }',
  'export function restore(row: Row) { row.deletedAt = null }',
  'export const visible = (rows: Row[]) => rows.filter((row) => row.deletedAt === null)',
  '```'
].join('\n')

describe('AG-071 code examples are graded against the topic rubric', () => {
  const rubric = rubricForTopic('TOPIC-34')!

  it('passes a complete example and reports non-core gaps', () => {
    const grade = gradeCodeExample(SOFT_DELETE, { language: 'TypeScript', rubric })
    expect(grade).toMatchObject({ verdict: 'pass', hasCode: true, languageOk: true })
    expect(grade.gaps).toContain('uniqueness collisions')
    expect(grade.method).toBe('keyword-heuristic')
  })

  it('fails a plausible snippet that omits restore', () => {
    const noRestore = SOFT_DELETE.replace(/export function restore[^\n]*\n/, '')
    expect(gradeCodeExample(noRestore, { language: 'TypeScript', rubric })).toMatchObject({
      verdict: 'fail',
      missingCore: ['restore']
    })
  })

  it('does not count prose for core behavior, wrong languages or missing code', () => {
    const prose = `${SOFT_DELETE.replace(/export function restore[^\n]*\n/, '')}\nYou can restore rows later.`
    expect(gradeCodeExample(prose, { rubric }).missingCore).toEqual(['restore'])
    expect(
      gradeCodeExample(SOFT_DELETE.replace('```ts', '```python'), { language: 'TypeScript' })
        .verdict
    ).toBe('fail')
    expect(
      gradeCodeExample('Use a deletedAt column and restore it later.', { rubric }).hasCode
    ).toBe(false)
  })

  it('covers all 40 topics, and every corpus question matches one', () => {
    expect(TOPIC_RUBRICS).toHaveLength(40)
    expect(TOPIC_RUBRICS.every((item) => item.behaviors.some((behavior) => behavior.core))).toBe(
      true
    )
    const corpus = prepareQuestions(
      readFileSync(
        join(__dirname, 'fixtures', '10000-natural-diverse-coding-questions.txt'),
        'utf8'
      ),
      '.txt'
    )
    const unmatched = corpus.questions.filter((question) => !rubricForTopic(question.text))
    expect(unmatched.map((question) => question.text).slice(0, 5)).toEqual([])
  })
})

describe('AG-072 claims need observed evidence', () => {
  const scenario = (expect: Partial<DebugScenario['expect']> = {}) =>
    ({
      ...builtinDebugScenarios().find((item) => item.id === 'edit-explicit-fix')!,
      expect: {
        mutation: 'any',
        requiredPaths: [],
        checks: [],
        forbiddenIntents: [],
        blockedEffects: [],
        ...expect
      }
    }) as DebugScenario
  const input = (
    answer: string,
    changedPaths: string[],
    verifications?: Array<{ ok: boolean; skipped: boolean }>
  ): OracleInput => ({
    scenario: scenario(),
    sandbox: tmpdir(),
    route: {
      expectedIntents: [],
      initialIntent: 'edit',
      semanticIntent: 'edit',
      intent: 'edit',
      agentId: 'composer',
      agentName: 'Composer',
      toolPolicy: 'edit',
      method: 'heuristic',
      reason: '',
      chatModel: '',
      toolsModel: ''
    },
    terminal: 'complete' as const,
    beforeWorkspace: {},
    changedPaths,
    answer,
    steps: 1,
    durationMs: 1,
    toolErrors: 0,
    toolFailureCodes: [],
    toolsUsed: [],
    blockedEffects: [],
    verifications
  })
  const failures = (checks: ReturnType<typeof evaluateScenario>) =>
    checks.filter((check) => !check.ok).map((check) => check.category)

  it('fails “implemented” when only prose was returned', () => {
    expect(failures(evaluateScenario(input('I have implemented the zero guard.', [])))).toEqual([
      'unsupported_claim'
    ])
    expect(
      failures(evaluateScenario(input('I have implemented the zero guard.', ['src/divide.ts'])))
    ).toEqual([])
  })

  it('fails a pass claim when verification failed or never ran', () => {
    expect(
      failures(
        evaluateScenario(
          input('DONE: fixed; all tests pass.', ['src/divide.ts'], [{ ok: false, skipped: false }])
        )
      )
    ).toEqual(['unsupported_claim'])
    expect(
      failures(evaluateScenario(input('Verification passed.', ['src/divide.ts'], [])))
    ).toEqual(['unsupported_claim'])
    expect(
      failures(
        evaluateScenario(
          input('Verification passed.', ['src/divide.ts'], [{ ok: true, skipped: false }])
        )
      )
    ).toEqual([])
  })
})

describe('AG-069/AG-083/AG-085 evaluation, taxonomy and typed outcomes', () => {
  const base = (overrides: Partial<DebugCaseResult>): DebugCaseResult =>
    ({
      runId: 'r',
      caseId: '1-x',
      index: 0,
      scenarioId: 'edit-explicit-fix',
      scenarioTitle: 'x',
      scenarioHash: 'h',
      mode: 'simulated',
      responseSource: 'scripted',
      status: 'passed',
      route: null,
      contract: null,
      terminal: 'complete',
      changedPaths: [],
      diffHash: null,
      outcomeReview: null,
      checks: [{ stage: 'route', name: 'intent', ok: true, expected: 'edit', actual: 'edit' }],
      modelCalls: [],
      blockedEffects: [],
      steps: 1,
      toolCalls: 0,
      toolErrors: 0,
      answerChars: 0,
      answerHash: 'a',
      timeline: [],
      timelineTruncated: false,
      warnings: [],
      durationMs: 1,
      startedAt: '',
      finishedAt: '',
      ...overrides
    }) as DebugCaseResult

  it('separates agent defects from environment and harness limits', () => {
    const fail = (category: string) =>
      base({
        status: 'failed',
        failure: { stage: 'route', category: category as never, detail: '' }
      })
    expect(outcomeClass(base({}))).toBe('passed')
    expect(outcomeClass(fail('intent_mismatch'))).toBe('agent_defect')
    expect(outcomeClass(fail('unsupported_claim'))).toBe('agent_defect')
    expect(outcomeClass(fail('provider_error'))).toBe('environment')
    expect(outcomeClass(fail('script_exhausted'))).toBe('harness')
    expect(outcomeClass(base({ checks: [] }))).toBe('ungraded')
  })

  it('never presents incomplete work as completed', () => {
    expect(caseOutcome(base({}))).toBe('completed')
    expect(caseOutcome(base({ terminal: 'incomplete' }))).toBe('partial')
    expect(caseOutcome(base({ status: 'timed_out', terminal: 'stopped' }))).toBe('timed_out')
    expect(caseOutcome(base({ status: 'failed', terminal: 'error' }))).toBe('failed')
  })

  it('states why each case passed, failed or is ungraded', () => {
    const scenario = builtinDebugScenarios().find(
      (item) => item.id === 'complete-example-soft-delete'
    )!
    const passed = evaluationOf(scenario, base({}))
    expect(passed).toMatchObject({ verdict: 'passed', label: { source: 'review-derived' } })
    const failed = evaluationOf(
      scenario,
      base({
        status: 'failed',
        failure: { stage: 'answer', category: 'answer_incomplete', detail: 'missing: restore' },
        checks: [
          {
            stage: 'answer',
            name: 'code example',
            ok: false,
            expected: 'x',
            actual: 'missing: restore'
          }
        ]
      })
    )
    expect(failed.rationale).toContain('answer_incomplete')
    expect(failed.evidence.failedChecks[0]).toContain('missing: restore')
    expect(evaluationOf(scenario, base({ checks: [] })).verdict).toBe('ungraded')
  })
})

describe('AG-070 coverage states what a run did not exercise', () => {
  it('lists live inference and desktop UI delivery as uncovered for scripted runs', () => {
    const scenarios = builtinDebugScenarios()
    const coverage = coverageOf(scenarios, [
      {
        scenarioId: 'edit-explicit-fix',
        route: { intent: 'edit' },
        contract: { artifact: 'patch' },
        modelCalls: [{ purpose: 'agent' }],
        responseSource: 'scripted',
        toolCalls: 2,
        changedPaths: ['src/divide.ts'],
        timeline: [{ kind: 'verification', summary: 'final verify passed' }],
        outcomeReview: { verdict: 'supported', reason: '' }
      } as unknown as DebugCaseResult
    ])
    expect(coverage.uncovered).toEqual(
      expect.arrayContaining(['live model inference', 'desktop chat UI delivery'])
    )
    expect(coverage.stages['tool execution']).toBe(1)
    expect(coverage.byArtifact).toEqual({ patch: 1 })
  })
})

describe('AG-075 sanitized exports', () => {
  it('removes a credential consistently while keeping identity and relative paths', () => {
    const sanitizer = new CaptureSanitizer({
      homeDir: '/Users/dev',
      tmpRoots: ['/var/folders/x/T']
    })
    const record = {
      questionId: '3f2a9c1b04de-1',
      sourceLine: 12,
      requests: [
        {
          messages: [
            {
              role: 'system',
              content:
                'Imported file: src/config.ts\nconst API_KEY = "sk-live-abcdefghijklmnopqrstuvwx"\nroot /private/var/folders/x/T/eris-dev-AbC123/src/config.ts\nhome /Users/dev/notes'
            }
          ]
        }
      ],
      task: { secret: 'password: hunter2hunter2', again: 'sk-live-abcdefghijklmnopqrstuvwx' }
    }
    const clean = sanitizer.value(record)
    const text = JSON.stringify(clean)
    expect(text).not.toContain('sk-live-abcdefghijklmnopqrstuvwx')
    expect(text).not.toContain('hunter2hunter2')
    expect(text).not.toContain('/Users/dev')
    expect(text).not.toContain('eris-dev-AbC123')
    expect(text).toContain('src/config.ts')
    expect(text).toContain('<workspace>/src/config.ts')
    expect(clean.questionId).toBe('3f2a9c1b04de-1')
    // Keyed, export-scoped 64-bit markers (FR-035).
    const tokens = text.match(/\[REDACTED:api-key:[0-9a-f]{16}\]/g) ?? []
    expect(tokens).toHaveLength(2)
    expect(new Set(tokens).size).toBe(1)
    expect(sanitizer.manifest().replacements).toMatchObject({ 'api-key': 2, 'home-path': 1 })
    expect(sanitizer.value(clean)).toEqual(clean)
  })
})

describe('AG-076 resumable runs', () => {
  const header = {
    created: '2026-10-23T00:00:00.000Z',
    settingsDigest: 's',
    versions: { routing: 'r', prompt: 'p' },
    fixture: { digest: 'f' },
    corpus: { name: 'corpus.txt' }
  } as unknown as DevRunHeader
  const manifest = (runId: string): RunManifest => ({
    runId,
    header,
    questions: prepareQuestions('a?\nb?\nc?', '.txt').questions,
    config: {
      context: 8192,
      mode: 'agent',
      intentReplyMode: 'fallback',
      projectKind: 'sample',
      project: null
    }
  })

  it('resumes at the first missing, unreadable or invalid case', () => {
    const dir = tempDir()
    const questions = prepareQuestions('a?\nb?\nc?', '.txt').questions
    const record = (index: number) => ({
      index,
      questionId: questions[index]!.id,
      question: questions[index]!.text,
      status: 'captured',
      stages: {},
      findings: {},
      phases: {},
      requests: [],
      findingsDetail: [],
      findingIds: [],
      events: []
    })
    // FR-025: valid JSON is not a completed case.
    writeFileSync(join(dir, '0.json'), '{}')
    expect(resumePoint(dir, questions)).toEqual({
      next: 0,
      unreadable: [],
      invalid: [{ index: 0, reason: 'index undefined does not match case 0' }]
    })
    writeFileSync(join(dir, '0.json'), JSON.stringify(record(0)))
    expect(resumePoint(dir, questions)).toMatchObject({ next: 1, unreadable: [] })
    writeFileSync(join(dir, '1.json'), '{"partial":')
    expect(resumePoint(dir, questions)).toMatchObject({ next: 1, unreadable: [1] })
  })

  it('refuses to resume under changed settings, versions or source', () => {
    const same = { settingsDigest: 's', routing: 'r', prompt: 'p', fixtureDigest: 'f' }
    expect(resumeConflicts(header, same)).toEqual([])
    expect(resumeConflicts(header, { ...same, settingsDigest: 'x', fixtureDigest: 'y' })).toEqual([
      'capture settings changed',
      'project snapshot changed'
    ])
  })

  it('marks runs left running as interrupted and lists them', () => {
    const captures = tempDir()
    const runId = '00000000-0000-4000-8000-000000000001'
    const dir = join(captures, runId)
    mkdirSync(dir)
    writeManifest(dir, manifest(runId))
    writeProgress(dir, {
      state: 'running',
      completed: 1,
      updatedAt: '',
      rewritten: [],
      resumedAt: []
    })
    expect(markInterruptedRuns(captures)).toBe(1)
    expect(readProgress(dir)?.state).toBe('interrupted')
    expect(listRuns(captures)).toEqual([
      expect.objectContaining({
        runId,
        created: header.created,
        corpus: 'corpus.txt',
        total: 3,
        completed: 1,
        state: 'interrupted',
        mode: 'agent',
        context: 8192,
        bytes: expect.any(Number)
      })
    ])
  })
})

describe('AG-077 run comparison by stable question ID', () => {
  const record = (overrides: Partial<DevResult>): DevResult =>
    readCaptureRecord({
      index: 2812,
      question: 'How would you design the data model and API for role-based access control?',
      status: 'captured',
      calls: 1,
      requests: [],
      events: [],
      durationMs: 1,
      questionId: 'q2813-1',
      ...overrides
    } as unknown as Record<string, unknown>)

  it('reports a route change and ignores task IDs, paths and timings', () => {
    const before = record({
      intent: 'capability',
      agent: 'Explainer',
      task: {
        taskId: 'a',
        scope: { workspaceRoot: '/tmp/one' },
        authority: { tools: 'none', edit: false, execute: 'none' }
      }
    } as Partial<DevResult>)
    const after = record({
      intent: 'explore',
      agent: 'Explainer',
      artifact: 'design',
      durationMs: 99,
      task: {
        taskId: 'b',
        scope: { workspaceRoot: '/tmp/two' },
        authority: { tools: 'none', edit: false, execute: 'none' }
      }
    } as Partial<DevResult>)
    const unchanged = record({
      questionId: 'other-1',
      intent: 'answer',
      task: { taskId: 'c', authority: { tools: 'none', edit: false, execute: 'none' } }
    } as Partial<DevResult>)
    const renamed = {
      ...unchanged,
      task: { ...(unchanged.task as object), taskId: 'd' },
      durationMs: 50
    }
    const comparison = compareCaptures([before, unchanged], [after, renamed as DevResult])
    expect(comparison.matched).toBe(2)
    expect(comparison.changed.map((item) => item.questionId)).toEqual(['q2813-1'])
    expect(comparison.transitions).toEqual({ 'capability → explore': 1 })
    expect(Object.keys(comparison.changed[0]!.changes).sort()).toEqual(['artifact', 'intent'])
  })
})

describe('defects found while qualifying', () => {
  it('keeps code fences in answers and strips only tool-call fences', () => {
    // FR-010: a fence is protocol only when the runtime would execute it — a reply of
    // nothing but envelope fences. Beside prose it documents a call and stays visible.
    const answer =
      'Here:\n```ts\nexport const x = 1\n```\n```json\n{"name":"read_file","path":"a.ts"}\n```'
    const out = stripToolBlocks(answer)
    expect(out).toContain('```ts\nexport const x = 1\n```')
    expect(out).toContain('read_file')
    expect(stripToolBlocks('```json\n{"name":"read_file","path":"a.ts"}\n```')).toBe('')
  })

  it('answers an Ask-mode edit request as a read-only chat', () => {
    expect(isReadOnlyChat({ intent: 'edit', toolPolicy: 'read' }, 'ask')).toBe(true)
    expect(isReadOnlyChat({ intent: 'edit', toolPolicy: 'edit' }, 'agent')).toBe(false)
  })
})
