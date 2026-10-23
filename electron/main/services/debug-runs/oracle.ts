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
import { rubricForTopic } from '../../../../src/shared/topic-rubrics'

/** The answer says something was changed or applied. */
const CHANGE_CLAIM =
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?|now)\s+(?:\w+\s+){0,2}?(?:implemented|added|fixed|updated|changed|created|applied|modified|refactored)\b|^\s*DONE:\s*(?:\w+\s+){0,3}?(?:implemented|added|fixed|updated|changed|created|applied|modified)\b/im
/** The answer says a check passed. */
const PASS_CLAIM =
  /\b(?:tests?|typecheck|lint|verification|build|checks?)\s+(?:all\s+)?(?:passed|pass|passes|succeeded|green)\b|\bverification passed\b/i

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
  verifications?: Array<{ ok: boolean; skipped: boolean }>
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
  if (changeTurn && CHANGE_CLAIM.test(input.answer)) {
    checks.push(
      check(
        'answer',
        'change claim has a diff',
        changed.length > 0,
        'claimed changes appear in the workspace',
        changed.length ? changed.join(', ') : 'answer claims changes; no file changed',
        'unsupported_claim'
      )
    )
  }
  if (input.verifications && PASS_CLAIM.test(input.answer)) {
    const passed = input.verifications.some((item) => item.ok && !item.skipped)
    checks.push(
      check(
        'answer',
        'pass claim was observed',
        passed,
        'a verification that actually passed',
        input.verifications.length
          ? input.verifications
              .map((item) => (item.skipped ? 'skipped' : item.ok ? 'passed' : 'failed'))
              .join(', ')
          : 'answer claims a pass; no verification ran',
        'unsupported_claim'
      )
    )
  }
  if (expect.codeExample) {
    const rubric = expect.codeExample.rubric ? rubricForTopic(expect.codeExample.rubric) : undefined
    const grade = gradeCodeExample(input.answer, {
      language: expect.codeExample.language,
      rubric,
      behaviors: expect.codeExample.behaviors
    })
    checks.push(
      check(
        'answer',
        'code example',
        grade.verdict === 'pass',
        [
          'fenced code',
          expect.codeExample.language ? `in ${expect.codeExample.language}` : '',
          rubric ? `covering ${rubric.id} core behaviors` : ''
        ]
          .filter(Boolean)
          .join(' '),
        !grade.hasCode
          ? 'no code block'
          : grade.languageOk === false
            ? `code in ${grade.languages.join(', ') || 'an untagged block'}`
            : grade.missingCore.length
              ? `missing: ${grade.missingCore.join(', ')}`
              : `covers ${grade.covered.join(', ')}${grade.gaps.length ? `; gaps: ${grade.gaps.join(', ')}` : ''} (keyword heuristic)`,
        'answer_incomplete'
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
