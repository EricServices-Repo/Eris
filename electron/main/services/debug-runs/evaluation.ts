import type {
  DebugCaseOutcome,
  DebugCaseResult,
  DebugCoverage,
  DebugEvaluation,
  DebugFailureCategory,
  DebugOutcomeClass,
  DebugScenario
} from '../../../../src/shared/debug-runs'

/** Categories caused by where or how a case ran rather than by the agent. */
const ENVIRONMENT: ReadonlySet<DebugFailureCategory> = new Set([
  'provider_error',
  'timed_out',
  'user_cancelled'
])
const HARNESS: ReadonlySet<DebugFailureCategory> = new Set([
  'fixture_invalid',
  'script_exhausted',
  'internal_error'
])

export function outcomeClass(result: DebugCaseResult): DebugOutcomeClass {
  if (!result.checks.length && !result.failure) return 'ungraded'
  if (result.status === 'passed') return 'passed'
  const category = result.failure?.category
  if (result.status === 'cancelled' || result.status === 'timed_out') return 'environment'
  if (category && ENVIRONMENT.has(category)) return 'environment'
  if (category && HARNESS.has(category)) return 'harness'
  return 'agent_defect'
}

/** The run's ending, independent of whether the oracle expected it. */
export function caseOutcome(result: DebugCaseResult): DebugCaseOutcome {
  if (result.status === 'cancelled') return 'cancelled'
  if (result.status === 'timed_out') return 'timed_out'
  if (result.terminal === 'error' || result.status === 'error') return 'failed'
  if (result.blockedEffects.length && result.terminal !== 'complete') return 'blocked'
  if (result.terminal === 'incomplete') return 'partial'
  return result.status === 'passed' ? 'completed' : 'failed'
}

const EVIDENCE_KINDS = new Set(['route', 'contract', 'tool', 'diff', 'verification', 'error', 'outcome_review'])

export function evaluationOf(scenario: DebugScenario, result: DebugCaseResult): DebugEvaluation {
  const failed = result.checks.filter((check) => !check.ok)
  const verdict = !result.checks.length && !result.failure
    ? 'ungraded'
    : result.status === 'passed'
      ? 'passed'
      : 'failed'
  const rationale =
    verdict === 'ungraded'
      ? 'The scenario has no expectations, so the case is not graded.'
      : verdict === 'passed'
        ? `All ${result.checks.length} checks passed.`
        : result.failure
          ? `${result.failure.stage} · ${result.failure.category}: ${result.failure.detail}`
          : `${failed.length} check(s) failed.`
  return {
    label: scenario.label ?? null,
    verdict,
    rationale,
    evidence: {
      answerHash: result.answerHash,
      diffHash: result.diffHash,
      timelineSeqs: result.timeline
        .filter((event) => EVIDENCE_KINDS.has(event.kind))
        .map((event) => event.seq),
      failedChecks: failed.map((check) => `${check.name}: expected ${check.expected}; actual ${check.actual}`)
    }
  }
}

/**
 * Stages a run can exercise. A stage no case reached is listed as uncovered, so a
 * run of scripted cases never reads as proof of live completion or UI delivery.
 */
const STAGES = [
  'routing',
  'live model inference',
  'scripted model inference',
  'tool execution',
  'workspace changes',
  'verification',
  'outcome review',
  'multi-turn follow-up',
  'specialist delegation',
  'desktop chat UI delivery'
] as const

export function coverageOf(
  scenarios: DebugScenario[],
  results: DebugCaseResult[]
): DebugCoverage {
  const stages: Record<string, number> = Object.fromEntries(STAGES.map((stage) => [stage, 0]))
  const byArtifact: Record<string, number> = {}
  const byTag: Record<string, number> = {}
  const add = (stage: (typeof STAGES)[number]) => (stages[stage] = (stages[stage] ?? 0) + 1)
  for (const result of results) {
    const scenario = scenarios.find((item) => item.id === result.scenarioId)
    if (result.route) add('routing')
    if (result.modelCalls.some((call) => call.purpose === 'agent')) {
      if (result.responseSource === 'live') add('live model inference')
      else add('scripted model inference')
    }
    if (result.toolCalls > 0) add('tool execution')
    if (result.changedPaths.length) add('workspace changes')
    if (result.timeline.some((event) => event.kind === 'verification')) add('verification')
    if (result.outcomeReview) add('outcome review')
    if ((result.turns?.length ?? 0) > 1) add('multi-turn follow-up')
    if (result.timeline.some((event) => /delegat/i.test(event.summary))) add('specialist delegation')
    const artifact = result.contract?.artifact ?? 'unknown'
    byArtifact[artifact] = (byArtifact[artifact] ?? 0) + 1
    for (const tag of scenario?.tags ?? []) byTag[tag] = (byTag[tag] ?? 0) + 1
  }
  return {
    cases: results.length,
    stages,
    uncovered: STAGES.filter((stage) => !stages[stage]),
    byArtifact,
    byTag
  }
}
