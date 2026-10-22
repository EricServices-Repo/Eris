import type { EvalCheck } from '../../../../src/shared/evals'
import {
  DEBUG_FAILURE_STAGES,
  type BlockedEffectKind,
  type DebugFailureCategory,
  type DebugFailureStage,
  type DebugOracleCheck,
  type DebugRouteRecord,
  type DebugScenario,
  type DebugTerminalState
} from '../../../../src/shared/debug-runs'
import { evaluateChecks } from '../eval-runner'

export interface OracleInput {
  scenario: DebugScenario
  sandbox: string
  route: DebugRouteRecord | null
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
