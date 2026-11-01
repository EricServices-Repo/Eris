import { createHash } from 'crypto'
import type { BackgroundJob } from '../../../src/shared/background-agents'
import type { ThreadWorkingState } from '../../../src/shared/thread-working-state'
import { ChildOutcomeSchema, type ChildOutcome } from '../../../src/shared/child-outcome'
import type { ContextEvidence } from '../../../src/shared/context-evidence'
export const outcomeDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Only runtime observations count; filesTouched and answer prose cannot manufacture effects/checks. */
export function childOutcome(
  job: BackgroundJob,
  state?: ThreadWorkingState,
  dependencies?: ContextEvidence
): ChildOutcome {
  const checks = state?.checks.slice(0, 8) ?? []
  const integration = job.integration?.state ?? 'unapplied'
  const verification = checks.some((check) => check.state === 'failed')
    ? 'failed'
    : checks.some((check) => check.state === 'stale')
      ? 'stale'
      : checks.length
        ? 'passed'
        : 'not-run'
  const value = {
    version: 1 as const,
    childTaskId: job.id,
    parentTaskId: job.parentId ?? null,
    rootTaskId: job.tree?.rootId ?? job.id,
    resultRevision: '0'.repeat(64),
    status: job.status,
    integration,
    verification,
    observed:
      ['done', 'merged'].includes(job.status) &&
      integration === 'integrated' &&
      Boolean(dependencies?.complete && dependencies.files.length) &&
      Boolean(state?.effects.length),
    effects: (state?.effects ?? [])
      .slice(0, 32)
      .map(({ id, path, digest }) => ({ id, path, digest })),
    checks,
    sourceIds: [
      ...new Set(
        job.handoff?.evidence?.flatMap((source) => source.items.map((item) => item.sourceId)) ?? []
      )
    ].slice(0, 32),
    unresolved: [
      ...(!['done', 'merged'].includes(job.status)
        ? [job.error ?? 'Child work is not complete.']
        : []),
      ...(integration !== 'integrated' && state?.effects.length
        ? ['Changes are not integrated into the source workspace.']
        : []),
      ...(state?.questions
        .filter((question) => !question.answered)
        .map((question) => question.text) ?? [])
    ]
      .slice(0, 8)
      .map((text) => text.slice(0, 300)),
    omitted:
      (state?.omitted ?? 0) +
      Math.max(0, (state?.effects.length ?? 0) - 32) +
      Math.max(0, (state?.checks.length ?? 0) - 8)
  }
  // Keep import metadata under the existing canonical recall receipt budget.
  while (
    Buffer.byteLength(JSON.stringify(value)) > 8000 &&
    (value.effects.length || value.checks.length)
  ) {
    if (value.effects.length) value.effects.pop()
    else value.checks.pop()
    value.omitted++
  }
  if (value.omitted) value.observed = false
  value.resultRevision = outcomeDigest([value, outcomeDigest(job.answer)])
  return ChildOutcomeSchema.parse(value)
}
