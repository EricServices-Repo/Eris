import type {
  DebugCaseOutcome,
  DebugCaseResult,
  DebugCoverage,
  DebugEvaluation,
  DebugFailureCategory,
  DebugOutcomeClass,
  DebugScenario,
  DebugTimeoutEvidence
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
  'evaluation_invalid',
  'internal_error'
])

/**
 * What the case was doing when it stopped, from its own evidence. A model wait that
 * fills the deadline is a provider stall; the same tool step repeated is agent work
 * going in circles; anything else stays unknown rather than defaulting to environment.
 */
export function timeoutEvidence(result: DebugCaseResult): DebugTimeoutEvidence {
  const modelWaitMs = result.modelCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0)
  const progress = result.timeline.filter((event) =>
    ['model_call', 'tool', 'diff', 'verification'].includes(event.kind)
  )
  const counts = new Map<string, number>()
  for (const event of result.timeline)
    if (event.kind === 'tool') counts.set(event.summary, (counts.get(event.summary) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const repeatedWork = top && top[1] >= 3 ? { summary: top[0], count: top[1] } : null
  const lastCall = result.modelCalls.at(-1)
  const cause: DebugTimeoutEvidence['cause'] =
    result.status === 'cancelled' || result.failure?.category === 'user_cancelled'
      ? 'user-cancelled'
      : repeatedWork
        ? 'repeated-work'
        : lastCall?.error ||
            (result.durationMs > 0 && modelWaitMs >= result.durationMs * 0.8)
          ? 'provider-stall'
          : 'unknown'
  return {
    cause,
    lastProgressMs: progress.at(-1)?.atMs ?? null,
    modelWaitMs,
    toolCalls: result.toolCalls,
    repeatedWork
  }
}

export function outcomeClass(result: DebugCaseResult): DebugOutcomeClass {
  if (!result.checks.length && !result.failure) return 'ungraded'
  if (result.status === 'passed') return 'passed'
  const category = result.failure?.category
  if (result.status === 'cancelled' || result.status === 'timed_out') {
    const cause = (result.timeoutEvidence ?? timeoutEvidence(result)).cause
    if (cause === 'repeated-work') return 'agent_defect'
    if (cause === 'provider-stall' || cause === 'user-cancelled') return 'environment'
    return 'unknown'
  }
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
  const zero = () => Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<string, number>
  const stages = zero()
  const attempts = zero()
  const passed = zero()
  const byArtifact: Record<string, number> = {}
  const byTag: Record<string, number> = {}
  type Stage = (typeof STAGES)[number]
  // Each stage is counted as attempted, completed (stages) and passed separately, so a
  // refused delegation or a failed provider call never reads as exercised work.
  const record = (stage: Stage, attempted: boolean, completed: boolean, ok = completed) => {
    if (attempted) attempts[stage]! += 1
    if (completed) stages[stage]! += 1
    if (completed && ok) passed[stage]! += 1
  }
  for (const result of results) {
    const scenario = scenarios.find((item) => item.id === result.scenarioId)
    record('routing', Boolean(result.route), Boolean(result.route))
    const agentCalls = result.modelCalls.filter((call) => call.purpose === 'agent')
    const answered = agentCalls.some(
      (call) => !call.error && !call.exhausted && (call.responseChars ?? 1) > 0
    )
    record(
      result.responseSource === 'live' ? 'live model inference' : 'scripted model inference',
      agentCalls.length > 0,
      answered
    )
    record('tool execution', result.toolCalls > 0, result.toolCalls - (result.toolErrors ?? 0) > 0)
    record('workspace changes', result.changedPaths.length > 0, result.changedPaths.length > 0)
    const verifications = result.timeline.filter((event) => event.kind === 'verification')
    record(
      'verification',
      verifications.length > 0,
      verifications.length > 0,
      verifications.length > 0 && verifications.every((event) => /\bpassed\b/i.test(event.summary))
    )
    record('outcome review', Boolean(result.outcomeReview), Boolean(result.outcomeReview))
    const turns = (result.turns?.length ?? 0) > 1
    record('multi-turn follow-up', turns, turns)
    // Typed delegation outcomes: “delegation reviewer: done”. Only an accepted child counts.
    const delegations = result.timeline
      .map((event) => event.summary.match(/^delegation\s+\S+:\s*(\w+)/i)?.[1]?.toLowerCase())
      .filter((status): status is string => Boolean(status))
    record('specialist delegation', delegations.length > 0, delegations.includes('done'))
    const artifact = result.contract?.artifact ?? 'unknown'
    byArtifact[artifact] = (byArtifact[artifact] ?? 0) + 1
    for (const tag of scenario?.tags ?? []) byTag[tag] = (byTag[tag] ?? 0) + 1
  }
  return {
    cases: results.length,
    stages,
    attempts,
    passed,
    uncovered: STAGES.filter((stage) => !stages[stage]),
    byArtifact,
    byTag
  }
}
