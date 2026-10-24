import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * docs/reviews/eris-dev-followup-2026-10-23/backlog.json, Batch A:
 * production routing at the request boundary (FR-002), separate effect
 * prohibitions (FR-003), quoted operands (FR-004/005) and language roles (FR-006).
 */

import { captureQuestion } from '../electron/dev/capture'
import { prepareQuestions } from '../electron/dev/questions'
import { classifyIntentTraced } from '../electron/main/services/chat-router'
import { resolverBypassRule } from '../electron/main/services/task-resolver'
import { createTaskContract } from '../electron/main/services/task-intake'
import {
  artifactResponseContract,
  effectConstraints,
  interpretRequest,
  isQuotedContentOnly,
  languageRoles,
  requestSpans,
  requestedLanguage
} from '../src/shared/task-interpretation'
import { taskContractConflicts } from '../src/shared/task-contract'
import { gradeCodeExample } from '../src/shared/code-grading'
import {
  extractRecommendations,
  recommendationAccounting,
  selectRecommendations
} from '../src/shared/recommendations'
import { completeChatTurnTask } from '../electron/main/services/chat-turn'
import { requestInvariantFindings } from '../electron/main/services/agent/request-invariants'
import { rubricForTopic } from '../src/shared/topic-rubrics'
import {
  assertedSentences,
  evaluateScenario,
  passClaimSupport
} from '../electron/main/services/debug-runs/oracle'
import { coverageOf, outcomeClass } from '../electron/main/services/debug-runs/evaluation'
import {
  DebugScenarioSchema,
  type DebugCaseResult,
  type DebugScenario
} from '../src/shared/debug-runs'
import type { DevResult } from '../src/shared/eris-dev'
import type { TurnPlan } from '../src/shared/settings-schema'

const corpus = prepareQuestions(
  readFileSync(join(__dirname, 'fixtures', '10000-natural-diverse-coding-questions.txt'), 'utf8'),
  '.txt'
)
const Q = (n: number) => corpus.questions[n - 1]!.text

const plan = (overrides: Partial<TurnPlan>): TurnPlan => ({
  intent: 'answer',
  agentId: 'explainer',
  agentName: 'Explainer',
  mode: 'agent',
  models: { chat: 'local:test', tools: 'local:test' },
  toolPolicy: 'none',
  requiresTools: false,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  ...overrides
})

let workspace = ''
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eris-followup-'))
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture' }))
  writeFileSync(join(workspace, 'index.js'), 'export const value = 1\n')
})
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

const capture = (text: string): Promise<DevResult> =>
  captureQuestion(0, text, workspace, 8192, 'agent', new AbortController().signal)

const systemPrompt = (result: DevResult) =>
  result.requests
    .filter((request) => request.purpose === 'agent')
    .flatMap((request) => request.messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n')

describe('FR-002 the production request boundary keeps chat examples in chat', () => {
  it.each([107, 413])(
    'Q%i: artifact, destination, authority, worker and prompt agree',
    async (n) => {
      const result = await capture(Q(n))
      expect(result.status).toBe('captured')
      expect(result.intent).toBe('answer')
      expect(result.artifact).toBe('code-example')
      const task = result.task as {
        deliverable: string
        authority: { edit: boolean; execute: string }
        interpretation: { destination: string }
      }
      expect(task.interpretation.destination).toBe('chat')
      expect(task.authority).toMatchObject({ edit: false, execute: 'none' })
      expect(result.agent).not.toBe('Composer')
      expect(systemPrompt(result)).toContain('RESPONSE CONTRACT — code example in chat')
      expect(result.findingsDetail).toEqual([])
    }
  )

  it('a named file still gets edit authority at the same boundary', async () => {
    const result = await capture('Add a greet function to index.js')
    expect(result.intent).toBe('edit')
    expect(result.artifact).toBe('patch')
    expect((result.task as { authority: { edit: boolean } }).authority.edit).toBe(true)
    expect(systemPrompt(result)).toContain('RESPONSE CONTRACT — patch')
  })
})

describe('FR-003 each prohibition removes only the effect it names', () => {
  const contract = (text: string, overrides: Partial<TurnPlan>) =>
    createTaskContract({ workspacePath: null, text, plan: plan(overrides) })

  it('“fix the bug but do not run tests” permits a patch and no commands', () => {
    const text = 'Fix the bug but do not run tests'
    expect(classifyIntentTraced(text, 'agent').intent).toBe('edit')
    expect(effectConstraints(text)).toMatchObject({
      edit: false,
      verification: true,
      execution: false
    })
    const task = contract(text, { intent: 'edit', toolPolicy: 'full', agentId: 'composer' })
    expect(task.deliverable).toBe('patch')
    expect(task.authority).toMatchObject({ edit: true, execute: 'none', tools: 'edit' })
    expect(taskContractConflicts(task)).toEqual([])
    const prompt = artifactResponseContract(task.interpretation!)
    expect(prompt).toContain('Do not run tests')
    expect(prompt).not.toContain('Do not change files')
  })

  it('“run the tests without changing files” permits checks and no edits', () => {
    const text = 'Run the tests without changing files'
    expect(classifyIntentTraced(text, 'agent')).toMatchObject({ intent: 'verify' })
    const task = contract(text, { intent: 'verify', toolPolicy: 'read', agentId: 'verifier' })
    expect(task.authority).toMatchObject({ edit: false, execute: 'verification' })
    expect(artifactResponseContract(task.interpretation!)).toContain('Do not change files.')
    expect(taskContractConflicts(task)).toEqual([])
  })

  it('“don’t commit” does not prohibit a local patch', () => {
    const text = 'Fix the login redirect bug but don’t commit'
    const task = contract(text, { intent: 'edit', toolPolicy: 'full', agentId: 'composer' })
    expect(task.authority).toMatchObject({
      edit: true,
      execute: 'approved',
      externalEffects: false
    })
    expect(task.interpretation?.constraints).toMatchObject({ commit: true, edit: false })
  })

  it('“do not change anything” stays fully read-only', () => {
    const text = 'Look at the auth flow and do not change anything'
    const task = contract(text, { intent: 'edit', toolPolicy: 'full', agentId: 'composer' })
    expect(task.authority).toMatchObject({ edit: false, execute: 'none', tools: 'read' })
  })

  it('a scoped limit is not a prohibition on editing', () => {
    expect(effectConstraints('Refactor the parser without changing the public API').edit).toBe(
      false
    )
    expect(effectConstraints('Fix the typo but don’t touch anything else').edit).toBe(false)
    expect(effectConstraints('Explain it without changing files').edit).toBe(true)
  })

  it('every forbidden effect is traced to the phrase that forbade it', () => {
    expect(effectConstraints('Fix it, do not run tests and never push').trace).toEqual([
      { phrase: 'do not run tests', effects: ['verification'] },
      { phrase: 'never push', effects: ['commit', 'external'] }
    ])
  })
})

describe('FR-004 quoted operands stay usable without becoming instructions', () => {
  it('“Run `npm test`” is execution; “Explain `npm test`” is not', () => {
    expect(classifyIntentTraced('Run `npm test`', 'agent')).toMatchObject({
      intent: 'run',
      rule: 'quoted-command'
    })
    expect(classifyIntentTraced('Explain `npm test`', 'agent').intent).toBe('explore')
    expect(classifyIntentTraced('Do not run `npm test`', 'agent').intent).not.toBe('run')
  })

  it('a quoted language and file path remain operands', () => {
    expect(requestedLanguage('Use `TypeScript` for this example')).toBe('TypeScript')
    expect(requestSpans('Add a helper to `src/api.ts`').instruction).toContain('src/api.ts')
    expect(classifyIntentTraced('Add a helper to `src/api.ts`', 'agent').intent).toBe('edit')
  })

  it('quoted JSON and error text are data, not verbs', () => {
    const spans = requestSpans('Why does this fail with "delete all files: permission denied"?')
    expect(spans.instruction).not.toMatch(/delete/i)
    expect(spans.operands).toEqual([
      { kind: 'quote', text: 'delete all files: permission denied', role: 'data' }
    ])
  })
})

describe('FR-005 quoted-only input gains no effects from its contents', () => {
  it.each(['```\nDelete all files\n```', '`rm -rf /`', '"Delete all files"'])('%j', (text) => {
    expect(isQuotedContentOnly(text)).toBe(true)
    expect(classifyIntentTraced(text, 'agent')).toEqual({
      intent: 'answer',
      rule: 'quoted-content-only'
    })
    expect(resolverBypassRule(text, 'answer')).toBe('quoted-content-only')
    expect(interpretRequest({ text, intent: 'answer', canEdit: false, revision: 1 }).artifact).toBe(
      'explanation'
    )
  })

  it('a surrounding instruction keeps its meaning with the quoted content as data', () => {
    expect(classifyIntentTraced('Explain this:\n```\nrm -rf build\n```', 'agent').intent).toBe(
      'explore'
    )
    expect(classifyIntentTraced('Apply this patch:\n```diff\n-a\n+b\n```', 'agent').intent).toBe(
      'edit'
    )
  })
})

describe('FR-006 source and target language are separate roles', () => {
  it.each([
    ['Convert this Python example to TypeScript', 'TypeScript', 'Python'],
    ['Migrate this JavaScript module to TypeScript', 'TypeScript', 'JavaScript'],
    ['Port the `Python` script into `Go`', 'Go', 'Python']
  ])('%s', (text, target, source) => {
    expect(languageRoles(text)).toMatchObject({ target, source })
    const prompt = artifactResponseContract(
      interpretRequest({ text, intent: 'answer', canEdit: false, revision: 1 })
    )
    expect(prompt).toContain(`Convert from ${source} to ${target}`)
  })

  it('a Django backend with a React frontend does not force one language', () => {
    const text = 'Show a Django backend plus React frontend for login'
    expect(languageRoles(text).target).toBeNull()
    const prompt = artifactResponseContract(
      interpretRequest({ text, intent: 'answer', canEdit: false, revision: 1 })
    )
    expect(prompt).toContain('Use Django, React as requested')
    expect(prompt).not.toContain('Python')
  })

  it('an explicit target outranks an earlier framework-implied language', () => {
    expect(requestedLanguage('Like Django does it, but write it in Go')).toBe('Go')
  })

  it('several named languages without a target stay visibly ambiguous', () => {
    const reading = interpretRequest({
      text: 'Compare Rust and Swift error handling',
      intent: 'answer',
      canEdit: false,
      revision: 1
    })
    expect(reading.languageAmbiguity).toEqual(['Rust', 'Swift'])
    expect(artifactResponseContract(reading)).toContain('names Rust and Swift')
  })
})

describe('FR-011 comments, strings and dead code do not satisfy implementation obligations', () => {
  const rubric = rubricForTopic('TOPIC-34')!
  it.each([
    ['comment-only', '```ts\n// deletedAt filter restore\n```'],
    ['TODO-only', '```ts\n// TODO: deletedAt, filter rows, restore\nfunction restore() {}\n```'],
    ['string-only', '```ts\nconst notes = "deletedAt filter restore"\n```'],
    [
      'dead code',
      '```ts\nexport function main(): void { if (false) { row.deletedAt = null; rows.filter(restore) } }\n```'
    ]
  ])('%s does not pass', (_, answer) => {
    const grade = gradeCodeExample(answer, { language: 'TypeScript', rubric })
    expect(grade.verdict).not.toBe('pass')
    // The textual hint is kept as its own diagnostic, not deleted.
    expect(grade.keywordCoverage.length).toBeGreaterThan(0)
  })

  it('keeps passing real code, SQL in strings included', () => {
    const answer = [
      '```ts',
      'export async function visible(db: Db) {',
      '  return db.query("SELECT * FROM rows WHERE deleted_at IS NULL")',
      '}',
      'export const restore = (row: Row) => { row.deletedAt = null }',
      '```'
    ].join('\n')
    expect(gradeCodeExample(answer, { language: 'TypeScript', rubric }).verdict).toBe('pass')
  })
})

describe('FR-012 the target-language block must carry the implementation', () => {
  it('an empty ts fence beside Python fails a TypeScript request', () => {
    const grade = gradeCodeExample('```ts\n\n```\n```python\nprint(1)\n```', {
      language: 'TypeScript'
    })
    expect(grade).toMatchObject({ verdict: 'fail', languageOk: false })
  })

  it('behaviors found only in another-language block do not count', () => {
    const answer =
      '```ts\nexport const answer = compute(41) + 1\n```\n```python\ndef restore(row):\n    row.deleted_at = None\n    return [r for r in rows if r.deleted_at is None]\n```'
    expect(
      gradeCodeExample(answer, { language: 'TypeScript', rubric: rubricForTopic('TOPIC-34') })
        .missingCore.length
    ).toBeGreaterThan(0)
  })

  it('Python syntax under a ts tag needs review', () => {
    const grade = gradeCodeExample('```ts\ndef restore(row):\n    row.deleted_at = None\n```', {
      language: 'TypeScript'
    })
    expect(grade.verdict).toBe('review')
  })

  it('a JSON config beside the TypeScript source still passes', () => {
    const answer =
      '```json\n{"compilerOptions":{"strict":true}}\n```\n```ts\nexport function softDelete(row: Row) { row.deletedAt = new Date() }\nexport function restore(row: Row) { row.deletedAt = null }\nexport const live = (rows: Row[]) => rows.filter((r) => r.deletedAt === null)\n```'
    expect(
      gradeCodeExample(answer, { language: 'TypeScript', rubric: rubricForTopic('TOPIC-34') })
        .verdict
    ).toBe('pass')
  })
})

describe('FR-013 invalid criteria are setup errors, never easier passes', () => {
  const base = {
    id: 'x',
    title: 'x',
    request: { text: 'Show soft deletes' },
    expect: {}
  }
  it.each([
    [{ rubric: 'TOPIC-99' }, /Unknown rubric/],
    [{ rubric: 'TOPIC-34', behaviors: ['typo'] }, /no behavior “typo”/],
    [{ rubric: 'TOPIC-34', behaviors: [] }, /filter is empty/],
    [{ rubric: 'TOPIC-34', behaviors: ['restore', 'restore'] }, /Duplicate behavior/]
  ])('%j is rejected when the scenario is planned', (codeExample, message) => {
    const parsed = DebugScenarioSchema.safeParse({ ...base, expect: { codeExample } })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(message)
  })

  it('a grade with an unresolved filter is invalid, not a pass', () => {
    expect(
      gradeCodeExample('```ts\nconst x = 1\n```', {
        rubric: rubricForTopic('TOPIC-34'),
        behaviors: ['typo']
      }).verdict
    ).toBe('invalid')
  })

  it('a valid explicit subset keeps its exact semantics', () => {
    const grade = gradeCodeExample(
      '```ts\nexport function restore(row: Row) { row.deletedAt = null }\n```',
      { language: 'TypeScript', rubric: rubricForTopic('TOPIC-34'), behaviors: ['restore'] }
    )
    expect(grade).toMatchObject({ verdict: 'pass', covered: ['restore'] })
  })
})

describe('FR-014 pass claims need the final result of the claimed check', () => {
  it('pass then fail does not support “all tests passed”', () => {
    expect(
      passClaimSupport('All tests passed.', [
        { ok: true, skipped: false },
        { ok: false, skipped: false }
      ]).ok
    ).toBe(false)
  })
  it('a failure superseded by a passing rerun of the same command supports the claim', () => {
    expect(
      passClaimSupport(
        'Tests pass now.',
        [
          { ok: false, skipped: false, command: 'npm test', revision: 'a' },
          { ok: true, skipped: false, command: 'npm test', revision: 'b' }
        ],
        'b'
      ).ok
    ).toBe(true)
  })
  it('lint success cannot justify a test claim', () => {
    expect(
      passClaimSupport('Tests passed.', [{ ok: true, skipped: false, command: 'npm run lint' }]).ok
    ).toBe(false)
  })
  it('an edit after the last test makes an unqualified claim stale', () => {
    const support = passClaimSupport(
      'All tests passed.',
      [{ ok: true, skipped: false, command: 'npm test', revision: 'before-edit' }],
      'after-edit'
    )
    expect(support).toMatchObject({ ok: false, actual: expect.stringContaining('stale') })
  })
  it('the oracle reports the probe case as unsupported', () => {
    const scenario = {
      expect: {
        mutation: 'any',
        requiredPaths: [],
        checks: [],
        forbiddenIntents: [],
        blockedEffects: []
      }
    } as unknown as DebugScenario
    const checks = evaluateScenario({
      scenario,
      sandbox: tmpdir(),
      route: null,
      terminal: 'complete',
      beforeWorkspace: {},
      changedPaths: [],
      answer: 'All tests passed.',
      steps: 1,
      durationMs: 1,
      toolErrors: 0,
      toolFailureCodes: [],
      toolsUsed: [],
      blockedEffects: [],
      verifications: [
        { ok: true, skipped: false },
        { ok: false, skipped: false }
      ]
    })
    expect(checks.find((item) => item.name === 'pass claim was observed')?.ok).toBe(false)
  })
})

describe('FR-015 an unrelated change does not substantiate an implementation claim', () => {
  const run = (
    changedPaths: string[],
    before: Record<string, string>,
    after: Record<string, string>
  ) =>
    evaluateScenario({
      scenario: {
        expect: {
          mutation: 'any',
          requiredPaths: [],
          checks: [],
          forbiddenIntents: [],
          blockedEffects: []
        }
      } as unknown as DebugScenario,
      sandbox: tmpdir(),
      route: { intent: 'edit' } as never,
      terminal: 'complete',
      beforeWorkspace: before,
      afterWorkspace: after,
      changedPaths,
      answer: 'I implemented authentication.',
      steps: 1,
      durationMs: 1,
      toolErrors: 0,
      toolFailureCodes: [],
      toolsUsed: [],
      blockedEffects: []
    }).find((item) => item.name === 'change claim has a diff')!
  it.each([
    ['README only', ['README.md'], { 'README.md': 'a' }, { 'README.md': 'b' }],
    ['whitespace only', ['src/a.ts'], { 'src/a.ts': 'x=1' }, { 'src/a.ts': 'x = 1\n' }],
    ['deleted failing test', ['src/a.test.ts'], { 'src/a.test.ts': 'it()' }, {}]
  ])('%s fails', (_, changed, before, after) => {
    expect(run(changed as string[], before, after).ok).toBe(false)
  })
  it('a real source change passes and says the behavior itself is unverified', () => {
    const check = run(['src/auth.ts'], {}, { 'src/auth.ts': 'export function login() {}' })
    expect(check.ok).toBe(true)
    expect(check.actual).toContain('no scenario paths or checks verify the claimed behavior')
  })
})

const caseResult = (overrides: Partial<DebugCaseResult>) =>
  ({
    scenarioId: 'edit-explicit-fix',
    status: 'timed_out',
    route: null,
    contract: null,
    checks: [],
    failure: { stage: 'lifecycle', category: 'timed_out', detail: '' },
    modelCalls: [],
    toolCalls: 0,
    toolErrors: 0,
    changedPaths: [],
    timeline: [],
    durationMs: 10_000,
    outcomeReview: null,
    responseSource: 'scripted',
    ...overrides
  }) as unknown as DebugCaseResult

describe('FR-017 a timeout is classified from its evidence, not its status', () => {
  it('a stalled provider is environment', () => {
    expect(
      outcomeClass(caseResult({ modelCalls: [{ purpose: 'agent', durationMs: 9_500 }] as never }))
    ).toBe('environment')
  })
  it('a repeated tool loop is an agent defect', () => {
    const loop = Array.from({ length: 4 }, (_, seq) => ({
      seq,
      atMs: seq * 1000,
      kind: 'tool',
      stage: 'tool_execution',
      summary: 'read_file src/a.ts ok'
    }))
    expect(outcomeClass(caseResult({ timeline: loop as never, toolCalls: 4 }))).toBe('agent_defect')
  })
  it('a timeout with no identifying evidence stays unknown', () => {
    expect(outcomeClass(caseResult({}))).toBe('unknown')
  })
})

describe('FR-018 coverage counts completed evidence separately from attempts', () => {
  it('a refused delegation and a failed provider call are attempts, not coverage', () => {
    const coverage = coverageOf(
      [],
      [
        caseResult({
          status: 'failed',
          modelCalls: [{ purpose: 'agent', error: 'provider down' }] as never,
          timeline: [
            {
              seq: 1,
              atMs: 1,
              kind: 'status',
              stage: 'tool_execution',
              summary: 'delegation reviewer: refused'
            },
            {
              seq: 2,
              atMs: 2,
              kind: 'verification',
              stage: 'verification',
              summary: 'final verify (scripted) failed'
            }
          ] as never
        })
      ]
    )
    expect(coverage.attempts!['specialist delegation']).toBe(1)
    expect(coverage.stages['specialist delegation']).toBe(0)
    expect(coverage.attempts!['scripted model inference']).toBe(1)
    expect(coverage.stages['scripted model inference']).toBe(0)
    expect(coverage.stages.verification).toBe(1)
    expect(coverage.passed!.verification).toBe(0)
    expect(coverage.uncovered).toContain('specialist delegation')
  })
})

describe('FR-007 implementing a long review accounts for every recommendation', () => {
  const review =
    'Recommendations:\n' +
    Array.from({ length: 40 }, (_, i) => `${i + 1}. Validate input ${i} in src/mod${i}.ts.`).join(
      '\n'
    )
  const prior = completeChatTurnTask(
    createTaskContract({
      workspacePath: null,
      text: 'Review the project and recommend improvements',
      plan: plan({ intent: 'review', toolPolicy: 'read', agentId: 'reviewer' })
    }),
    { answer: review, changedFiles: [], terminal: 'complete' }
  )
  const follow = createTaskContract({
    workspacePath: null,
    text: 'Implement all of them',
    plan: plan({ intent: 'edit', toolPolicy: 'edit', agentId: 'composer' }),
    priorTask: prior
  })

  it('all 40 become obligations, with an accounting obligation', () => {
    expect(prior.result?.offeredRecommendations).toHaveLength(40)
    expect(follow.recommendations).toHaveLength(40)
    const obligations = follow.interpretation!.obligations
    expect(obligations.filter((item) => item.id.startsWith('recommendation-'))).toHaveLength(40)
    expect(obligations.find((item) => item.id === 'accounting-recommendations')?.text).toContain(
      'all 40'
    )
    expect(
      requestInvariantFindings({
        task: follow,
        requests: [],
        imagesEnabled: false,
        mcpToolCount: 0
      })
    ).toEqual([])
  })

  it('a completed turn records a state for every item; unmentioned ones are pending', () => {
    const answer =
      '1. Completed.\n2. Deferred — needs a schema migration\n3. Blocked: no access to src/mod2.ts'
    const done = completeChatTurnTask(follow, {
      answer,
      changedFiles: ['src/mod0.ts'],
      terminal: 'complete'
    })
    const status = done.result!.recommendationStatus!
    expect(status).toHaveLength(40)
    expect(status.slice(0, 3)).toEqual([
      { id: follow.recommendations[0]!.id, state: 'completed' },
      { id: follow.recommendations[1]!.id, state: 'deferred', reason: 'needs a schema migration' },
      { id: follow.recommendations[2]!.id, state: 'blocked', reason: 'no access to src/mod2.ts' }
    ])
    expect(status.filter((item) => item.state === 'pending')).toHaveLength(37)
  })

  it('accounting reads “Recommendation N:” lines too', () => {
    const items = extractRecommendations('- Validate the token.\n- Cache the lookup.')
    expect(
      recommendationAccounting('Recommendation 2: done', items).map((item) => item.state)
    ).toEqual(['pending', 'completed'])
  })
})

describe('FR-008 follow-ups select a subset of recommendations', () => {
  const offered = extractRecommendations(
    [
      'Recommendations:',
      '1. Validate the retry count in src/retry.ts.',
      '2. Add caching for the user lookup.',
      '3. Enforce rate limiting on login.',
      '4. Document the retry policy.'
    ].join('\n')
  )
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id)

  it.each([
    ['Only implement items 2 and 4', [2, 4]],
    ['Do recommendations 1-3', [1, 2, 3]],
    ['Just the first one', [1]],
    ['Apply the last one', [4]],
    ['Implement the rate limiting one', [3]],
    ['Implement all except caching', [1, 3, 4]],
    ['Do everything but #4', [1, 2, 3]]
  ])('%s', (text, numbers) => {
    const selection = selectRecommendations(text, offered)
    expect(selection.unresolved).toBeUndefined()
    expect(ids(selection.selected)).toEqual(numbers.map((n) => offered[n - 1]!.id))
  })

  it.each(['Implement item 7', 'Implement all except the websocket one'])(
    '“%s” cannot be resolved and is asked about',
    (text) => {
      expect(selectRecommendations(text, offered).unresolved).toBeTruthy()
    }
  )

  it('the contract carries only the selected items and why the rest were left out', () => {
    const prior = completeChatTurnTask(
      createTaskContract({
        workspacePath: null,
        text: 'Review the retry code',
        plan: plan({ intent: 'review', toolPolicy: 'read', agentId: 'reviewer' })
      }),
      {
        answer: offered.map((item, i) => `${i + 1}. ${item.text}`).join('\n'),
        changedFiles: [],
        terminal: 'complete'
      }
    )
    const task = createTaskContract({
      workspacePath: null,
      text: 'Only implement items 2 and 4',
      plan: plan({ intent: 'edit', toolPolicy: 'edit', agentId: 'composer' }),
      priorTask: prior
    })
    expect(task.recommendations.map((item) => item.text)).toEqual([
      'Add caching for the user lookup.',
      'Document the retry policy.'
    ])
    expect(task.recommendationSelection).toMatchObject({ mode: 'numbered' })
    expect(task.recommendationSelection!.excludedIds).toHaveLength(2)
    const unresolved = createTaskContract({
      workspacePath: null,
      text: 'Implement item 9',
      plan: plan({ intent: 'edit', toolPolicy: 'edit', agentId: 'composer' }),
      priorTask: prior
    })
    expect(unresolved.recommendations).toEqual([])
    expect(
      unresolved.interpretation!.obligations.find(
        (item) => item.id === 'clarify-recommendation-selection'
      )?.text
    ).toContain('There is no recommendation 9')
  })
})

describe('FR-009 only actionable list items are recommendations', () => {
  it('dependencies, findings and quoted lists are not offers', () => {
    const answer = [
      'Dependencies:',
      '- zod ^3.24',
      '- vitest',
      '',
      'Observed failures:',
      '- login.test.ts fails with a timeout',
      '',
      '> - a quoted list item that says add caching',
      '',
      '```',
      '- add caching inside a code block',
      '```',
      '',
      'Recommendations:',
      '- Cap retries at MAX_RETRIES.',
      '- Add a timeout to the login request.'
    ].join('\n')
    expect(extractRecommendations(answer).map((item) => item.text)).toEqual([
      'Cap retries at MAX_RETRIES.',
      'Add a timeout to the login request.'
    ])
  })

  it('rewording the introduction keeps every ID; repeated items stay distinct', () => {
    const body =
      'Recommendations:\n- Validate the token.\n- Cache the lookup.\n- Validate the token.'
    const a = extractRecommendations(`Here is my review.\n\n${body}`)
    const b = extractRecommendations(`After reading the code carefully, I suggest:\n\n${body}`)
    expect(b.map((item) => item.id)).toEqual(a.map((item) => item.id))
    expect(new Set(a.map((item) => item.id)).size).toBe(3)
  })
})

describe('FR-016 claim detection reads the answer’s own assertions', () => {
  const scenario = {
    expect: {
      mutation: 'any',
      requiredPaths: [],
      checks: [],
      forbiddenIntents: [],
      blockedEffects: []
    }
  } as unknown as DebugScenario
  const checksFor = (answer: string) =>
    evaluateScenario({
      scenario,
      sandbox: tmpdir(),
      route: { intent: 'edit' } as never,
      terminal: 'complete',
      beforeWorkspace: {},
      changedPaths: [],
      answer,
      steps: 1,
      durationMs: 1,
      toolErrors: 0,
      toolFailureCodes: [],
      toolsUsed: [],
      blockedEffects: [],
      verifications: []
    }).map((item) => item.name)

  it.each([
    'Authentication is now implemented.',
    'The handler has been fixed.',
    'Everything is green.',
    'All tests are passing.'
  ])('“%s” is a claim', (answer) => {
    expect(checksFor(answer).some((name) => /claim/.test(name))).toBe(true)
  })

  it.each([
    'Tests did not pass; see the log.',
    'Authentication is not implemented yet.',
    'Run it and you should see "all tests passed" in the output.',
    '> I have implemented this before.',
    '```\nconsole.log("tests passed")\n```'
  ])('“%s” is not a claim', (answer) => {
    expect(checksFor(answer).filter((name) => /claim/.test(name))).toEqual([])
  })

  it('keeps passive and partial claims as sentences', () => {
    expect(
      assertedSentences(
        'Retry is partially implemented. Docs were not updated.',
        /\bimplemented\b|\bupdated\b/
      )
    ).toEqual(['Retry is partially implemented.'])
  })
})
