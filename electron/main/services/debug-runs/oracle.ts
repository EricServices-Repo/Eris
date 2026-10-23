import type { EvalCheck } from '../../../../src/shared/evals'
import {
  DEBUG_FAILURE_STAGES,
  type BlockedEffectKind,
  type DebugFailureCategory,
  type DebugFailureStage,
  type DebugContractRecord,
  type DebugOracleCheck,
  type DebugRouteRecord,
  type DebugScenario,
  type DebugTerminalState
} from '../../../../src/shared/debug-runs'
import { evaluateChecks } from '../eval-runner'
import { gradeCodeExample } from '../../../../src/shared/code-grading'
import { TOPIC_RUBRICS } from '../../../../src/shared/topic-rubrics'

/** The answer says something was changed or applied, actively or passively. */
const CHANGE_CLAIM =
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?|now)\s+(?:\w+\s+){0,2}?(?:implemented|added|fixed|updated|changed|created|applied|modified|refactored)\b|\b(?:is|are|has\s+been|have\s+been|was|were)\s+(?:now\s+)?(?:fully\s+|successfully\s+)?(?:implemented|added|fixed|updated|changed|created|applied|modified|refactored)\b|^\s*DONE:\s*(?:\w+\s+){0,3}?(?:implemented|added|fixed|updated|changed|created|applied|modified)\b/im
/** The answer says a check passed. */
const PASS_CLAIM =
  /\b(?:tests?|typecheck|lint|verification|build|checks?)\s+(?:all\s+)?(?:passed|pass|passes|succeeded|green)\b|\bverification passed\b|\b(?:tests?|checks?|builds?)\s+(?:are|were|have\s+been|is)\s+(?:all\s+)?(?:passing|passed|green|successful)\b|\b(?:everything|all\s+checks|ci)\s+(?:is\s+|are\s+)?(?:green|passing)\b/i
const NEGATED =
  /\b(?:not|n't|never|no|none|failed|fail|unable|cannot|couldn't|wasn't|weren't|haven't|hasn't|isn't|aren't)\b/i

/**
 * Sentences the answer asserts in its own voice: code, quotes and blockquotes are
 * removed, and a sentence that negates its claim (“tests did not pass”) is dropped.
 * Regex claims are a secondary consistency check over observed state, never the
 * primary record of what happened.
 */
export function assertedSentences(answer: string, claim: RegExp): string[] {
  const own = answer
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/"[^"\n]{1,300}"|“[^”\n]{1,300}”/g, ' ')
  return own
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => claim.test(sentence))
    .filter((sentence) => {
      // Negation before the claim, in the same sentence, withdraws it.
      const match = sentence.match(claim)
      const before = sentence.slice(0, match?.index ?? 0)
      const after = sentence.slice(
        (match?.index ?? 0) + (match?.[0].length ?? 0),
        (match?.index ?? 0) + (match?.[0].length ?? 0) + 12
      )
      return (
        !NEGATED.test(before.split(/[,;:]/).pop() ?? '') &&
        !/^\s*(?:yet|not)\b/i.test(after) &&
        !NEGATED.test(match?.[0] ?? '')
      )
    })
}

const claims = (answer: string, claim: RegExp) => assertedSentences(answer, claim).length > 0

export type VerificationKind = 'test' | 'typecheck' | 'lint' | 'build' | 'other'

/** One verification the harness observed, bound to its command and workspace revision. */
export interface ObservedVerification {
  ok: boolean
  skipped: boolean
  /** The command that ran; absent on records from before commands were kept. */
  command?: string
  /** Workspace digest when the check ran; a later edit makes the result stale. */
  revision?: string
}

export function verificationKind(command: string | undefined): VerificationKind | null {
  if (!command) return null
  if (/\b(?:tsc|typecheck|type-check|mypy|pyright)\b/i.test(command)) return 'typecheck'
  if (/\b(?:lint|eslint|ruff|clippy|rubocop|golangci)\b/i.test(command)) return 'lint'
  if (
    /\b(?:test|tests|spec|vitest|jest|pytest|mocha|rspec|cargo\s+test|go\s+test)\b/i.test(command)
  )
    return 'test'
  if (/\bbuild\b/i.test(command)) return 'build'
  return 'other'
}

/** Which kinds of check a pass claim names. “All checks passed” names every kind. */
function claimedKinds(answer: string): Array<VerificationKind | 'all'> {
  const kinds = new Set<VerificationKind | 'all'>()
  const asserted = assertedSentences(answer, PASS_CLAIM).join('\n')
  for (const match of asserted.matchAll(new RegExp(PASS_CLAIM.source, 'gi'))) {
    const noun = match[0].toLowerCase()
    if (/^tests?\b/.test(noun)) kinds.add('test')
    else if (/^typecheck/.test(noun)) kinds.add('typecheck')
    else if (/^lint/.test(noun)) kinds.add('lint')
    else if (/^build/.test(noun)) kinds.add('build')
    else kinds.add('all')
  }
  if (/\ball\s+(?:the\s+)?(?:tests?|checks?)\b/i.test(asserted)) kinds.add('all')
  return [...kinds]
}

/**
 * A pass claim is supported only by the latest result of each relevant command,
 * on the final workspace revision. A failure is superseded only by a passing rerun
 * of the same command; lint passing never supports “tests passed”.
 */
export function passClaimSupport(
  answer: string,
  verifications: ObservedVerification[],
  finalRevision?: string
): { ok: boolean; actual: string } {
  const ran = verifications.filter((item) => !item.skipped)
  if (!ran.length)
    return {
      ok: false,
      actual: verifications.length
        ? verifications.map(() => 'skipped').join(', ')
        : 'answer claims a pass; no verification ran'
    }
  const latest = new Map<string, ObservedVerification>()
  for (const item of ran) latest.set(item.command ?? '', item)
  const describe = (item: ObservedVerification) =>
    `${item.command ? `${item.command}: ` : ''}${item.ok ? 'passed' : 'failed'}${
      finalRevision && item.revision && item.revision !== finalRevision ? ' (stale revision)' : ''
    }`
  const problems: string[] = []
  for (const kind of claimedKinds(answer)) {
    const relevant = [...latest.values()].filter(
      (item) => kind === 'all' || !item.command || verificationKind(item.command) === kind
    )
    if (!relevant.length) problems.push(`no ${kind} check ran`)
    for (const item of relevant) {
      if (!item.ok) problems.push(describe(item))
      else if (finalRevision && item.revision && item.revision !== finalRevision)
        problems.push(describe(item))
    }
  }
  return {
    ok: problems.length === 0,
    actual: problems.length
      ? `${problems.join('; ')} — observed ${ran.map(describe).join(', ')}`
      : ran.map(describe).join(', ')
  }
}

/** Files that cannot substantiate a feature: docs, lockfiles, and deleted tests. */
function substantiveChanges(
  changed: string[],
  before: Record<string, string>,
  after: Record<string, string> | undefined
): string[] {
  return changed.filter((path) => {
    if (
      /(?:^|\/)(?:README|CHANGELOG|LICENSE)[^/]*$|\.(?:md|txt|rst)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(
        path
      )
    )
      return false
    if (!after) return true
    const next = after[path]
    const prior = before[path]
    // Deleting a test file, or a whitespace-only edit, is not an implementation.
    if (next === undefined)
      return !/(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[\w]+$/i.test(path)
    if (prior !== undefined && prior.replace(/\s+/g, '') === next.replace(/\s+/g, '')) return false
    return true
  })
}

export interface OracleInput {
  scenario: DebugScenario
  sandbox: string
  route: DebugRouteRecord | null
  contract?: DebugContractRecord | null
  terminal: DebugTerminalState | null
  beforeWorkspace: Record<string, string>
  changedPaths: string[]
  answer: string
  steps: number
  durationMs: number
  toolErrors: number
  toolFailureCodes: string[]
  toolsUsed: string[]
  blockedEffects: BlockedEffectKind[]
  /** Verification results the harness observed, in order. Absent: not tracked. */
  verifications?: ObservedVerification[]
  /** Workspace digest at the end of the turn, to detect checks made stale by later edits. */
  finalRevision?: string
  /** Workspace after the turn; lets claim checks ignore whitespace-only and doc-only edits. */
  afterWorkspace?: Record<string, string>
}

function check(
  stage: DebugFailureStage,
  name: string,
  ok: boolean,
  expected: string,
  actual: string,
  category: DebugFailureCategory
): DebugOracleCheck {
  return ok
    ? { stage, name, ok, expected, actual }
    : { stage, name, ok, expected, actual, category }
}

function pathAllowed(path: string, allowed: string[]): boolean {
  return allowed.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
}

function evalCheckStage(item: EvalCheck): DebugFailureStage {
  if (item.type === 'answer_contains' || item.type === 'answer_matches') return 'answer'
  if (item.type === 'tool_used' || item.type === 'max_tool_errors') return 'tool_execution'
  if (item.type === 'max_steps' || item.type === 'max_duration_ms') return 'lifecycle'
  return 'workspace_effects'
}

/**
 * Explicit, deterministic oracle. Route correctness, tool protocol, workspace
 * effects, answer checks, and terminal state are reported separately; an
 * answer that claims success never substitutes for a required diff.
 */
export function evaluateScenario(input: OracleInput): DebugOracleCheck[] {
  const expect = input.scenario.expect
  const checks: DebugOracleCheck[] = []
  const changed = input.changedPaths

  if (expect.intent) {
    const actual = input.route?.intent ?? 'not routed'
    checks.push(
      check(
        'route',
        'intent',
        Boolean(input.route && expect.intent.includes(input.route.intent)),
        expect.intent.join(' | '),
        actual,
        'intent_mismatch'
      )
    )
  }
  if (expect.forbiddenIntents.length) {
    const actual = input.route?.intent ?? 'not routed'
    checks.push(
      check(
        'route',
        'intent not forbidden',
        Boolean(input.route && !expect.forbiddenIntents.includes(input.route.intent)),
        `not ${expect.forbiddenIntents.join(' | ')}`,
        actual,
        'intent_mismatch'
      )
    )
  }
  if (expect.artifact) {
    const actual = input.contract?.artifact ?? 'no interpretation'
    checks.push(
      check(
        'route',
        'requested artifact',
        Boolean(input.contract?.artifact && expect.artifact.includes(input.contract.artifact)),
        expect.artifact.join(' | '),
        actual,
        'artifact_mismatch'
      )
    )
  }
  if (expect.recommendations) {
    const count = input.contract?.recommendations ?? 0
    const source = input.contract?.recommendationSource ?? 'none'
    const wanted = expect.recommendations
    checks.push(
      check(
        'route',
        'referenced recommendations',
        count >= wanted.min && (!wanted.source || source === wanted.source),
        `≥ ${wanted.min}${wanted.source ? ` from ${wanted.source}` : ''}`,
        `${count} from ${source}`,
        'intent_mismatch'
      )
    )
  }
  if (expect.priorChangedFiles) {
    const actual = input.contract?.priorChangedFiles ?? []
    const missing = expect.priorChangedFiles.filter((path) => !actual.includes(path))
    checks.push(
      check(
        'route',
        'prior changes carried',
        missing.length === 0,
        expect.priorChangedFiles.join(', '),
        actual.length ? actual.join(', ') : 'none',
        'check_failed'
      )
    )
  }
  if (expect.agentId) {
    checks.push(
      check(
        'route',
        'agent',
        input.route?.agentId === expect.agentId,
        expect.agentId,
        input.route?.agentId ?? 'not routed',
        'agent_mismatch'
      )
    )
  }
  if (expect.maxToolErrors !== undefined) {
    const schema = input.toolFailureCodes.some((code) => /invalid|parse|schema/i.test(code))
    const unavailable = input.toolFailureCodes.some((code) => /unavailable|unknown/i.test(code))
    checks.push(
      check(
        'tool_protocol',
        'tool errors',
        input.toolErrors <= expect.maxToolErrors,
        `≤ ${expect.maxToolErrors}`,
        `${input.toolErrors}${input.toolFailureCodes.length ? ` (${[...new Set(input.toolFailureCodes)].join(', ')})` : ''}`,
        schema ? 'tool_schema_invalid' : unavailable ? 'tool_unavailable' : 'tool_failed'
      )
    )
  }
  if (expect.mutation === 'required') {
    checks.push(
      check(
        'workspace_effects',
        'mutation required',
        changed.length > 0,
        'at least one changed file',
        changed.length ? changed.join(', ') : 'no files changed',
        'mutation_not_applied'
      )
    )
  } else if (expect.mutation === 'forbidden') {
    checks.push(
      check(
        'workspace_effects',
        'no mutation',
        changed.length === 0,
        'no changed files',
        changed.length ? changed.join(', ') : 'no files changed',
        'unexpected_mutation'
      )
    )
  }
  if (expect.allowedPaths) {
    const outside = changed.filter((path) => !pathAllowed(path, expect.allowedPaths!))
    checks.push(
      check(
        'workspace_effects',
        'change scope',
        outside.length === 0,
        `changes within ${expect.allowedPaths.join(', ') || '(nothing)'}`,
        outside.length ? `outside scope: ${outside.join(', ')}` : 'all changes in scope',
        'scope_violation'
      )
    )
  }
  for (const path of expect.requiredPaths) {
    checks.push(
      check(
        'workspace_effects',
        `changed ${path}`,
        changed.includes(path),
        `${path} changed`,
        changed.includes(path) ? 'changed' : 'unchanged',
        'required_path_missing'
      )
    )
  }
  const evalResults = evaluateChecks(input.sandbox, expect.checks, {
    answer: input.answer,
    snapshot: {},
    files: input.beforeWorkspace,
    beforeWorkspace: input.beforeWorkspace,
    steps: input.steps,
    toolErrors: input.toolErrors,
    durationMs: input.durationMs,
    toolsUsed: input.toolsUsed
  })
  for (const result of evalResults) {
    const label =
      'path' in result.check ? `${result.check.type} ${result.check.path}` : result.check.type
    checks.push(
      check(
        evalCheckStage(result.check),
        label,
        result.ok,
        describeEvalCheck(result.check),
        result.detail,
        'check_failed'
      )
    )
  }
  for (const kind of expect.blockedEffects) {
    checks.push(
      check(
        'tool_execution',
        `blocked ${kind}`,
        input.blockedEffects.includes(kind),
        `${kind} refused by the diagnostics boundary`,
        input.blockedEffects.includes(kind) ? 'refused' : 'not attempted',
        'blocked_effect_missing'
      )
    )
  }
  // An implementation claim needs a diff, and a passing claim needs an observed pass.
  const changeTurn =
    expect.mutation === 'required' ||
    ['edit', 'run'].includes(input.route?.intent ?? '') ||
    input.contract?.artifact === 'patch'
  if (changeTurn && claims(input.answer, CHANGE_CLAIM)) {
    // A diff only shows that a change occurred. A README edit, a whitespace-only edit,
    // or a deleted test never substantiates “I implemented …”; the requested behavior
    // is the scenario's own requiredPaths and checks, reported separately above.
    const substantive = substantiveChanges(changed, input.beforeWorkspace, input.afterWorkspace)
    checks.push(
      check(
        'answer',
        'change claim has a diff',
        substantive.length > 0,
        'claimed changes appear as substantive source changes',
        substantive.length
          ? `${substantive.join(', ')}${
              expect.requiredPaths.length || expect.checks.length
                ? ''
                : ' (a change occurred; no scenario paths or checks verify the claimed behavior)'
            }`
          : changed.length
            ? `only non-substantive changes: ${changed.join(', ')}`
            : 'answer claims changes; no file changed',
        'unsupported_claim'
      )
    )
  }
  if (input.verifications && claims(input.answer, PASS_CLAIM)) {
    const support = passClaimSupport(input.answer, input.verifications, input.finalRevision)
    checks.push(
      check(
        'answer',
        'pass claim was observed',
        support.ok,
        'the latest run of each claimed check passed on the final revision',
        support.actual,
        'unsupported_claim'
      )
    )
  }
  if (expect.codeExample) {
    // Exact ID lookup: a misspelled rubric must not resolve to a looser text match or to none.
    const rubricId = expect.codeExample.rubric
    const rubric = rubricId ? TOPIC_RUBRICS.find((item) => item.id === rubricId) : undefined
    const grade = gradeCodeExample(input.answer, {
      language: expect.codeExample.language,
      rubric,
      rubricId,
      behaviors: expect.codeExample.behaviors
    })
    const behaviors = expect.codeExample.behaviors
    checks.push(
      check(
        'answer',
        'code example',
        grade.verdict === 'pass',
        [
          'fenced code',
          expect.codeExample.language ? `in ${expect.codeExample.language}` : '',
          rubric
            ? `covering ${rubric.id} ${behaviors ? `behaviors ${behaviors.join(', ')}` : 'core behaviors'}`
            : ''
        ]
          .filter(Boolean)
          .join(' '),
        grade.verdict === 'invalid'
          ? `evaluation criteria invalid: ${grade.configErrors!.join(' ')}`
          : !grade.hasCode
            ? 'no executable code block (empty, comment-only or TODO-only)'
            : grade.languageOk === false
              ? `no nonempty ${expect.codeExample.language} block; found ${grade.languages.join(', ') || 'untagged blocks'}`
              : grade.missingCore.length
                ? `missing in code: ${grade.missingCore.join(', ')}${
                    grade.keywordCoverage.length
                      ? `; keywords elsewhere: ${grade.keywordCoverage.join(', ')}`
                      : ''
                  }`
                : grade.verdict === 'review'
                  ? `needs review: ${grade.review!.join(' ')}`
                  : `covers ${grade.covered.join(', ')}${grade.gaps.length ? `; gaps: ${grade.gaps.join(', ')}` : ''} (keyword heuristic over code tokens; not executed)`,
        grade.verdict === 'invalid' ? 'evaluation_invalid' : 'answer_incomplete'
      )
    )
  }
  if (expect.terminal) {
    checks.push(
      check(
        'lifecycle',
        'terminal state',
        input.terminal === expect.terminal,
        expect.terminal,
        input.terminal ?? 'none',
        'terminal_mismatch'
      )
    )
  }
  return checks
}

function describeEvalCheck(item: EvalCheck): string {
  switch (item.type) {
    case 'file_contains':
    case 'answer_contains':
      return `contains “${item.text.slice(0, 80)}”`
    case 'file_matches':
    case 'answer_matches':
      return `matches /${item.pattern}/`
    case 'tool_used':
      return `uses ${item.name}`
    case 'max_steps':
    case 'max_tool_errors':
    case 'max_duration_ms':
      return `≤ ${item.value}`
    default:
      return item.type
  }
}

/** The earliest failing check by pipeline stage identifies the case's failure. */
export function firstFailure(checks: DebugOracleCheck[]): DebugOracleCheck | undefined {
  return checks
    .filter((item) => !item.ok)
    .sort(
      (a, b) => DEBUG_FAILURE_STAGES.indexOf(a.stage) - DEBUG_FAILURE_STAGES.indexOf(b.stage)
    )[0]
}
