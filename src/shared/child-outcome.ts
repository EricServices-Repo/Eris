import { z } from 'zod'
const short = z.string().max(256)
export const ChildOutcomeSchema = z.object({
  version: z.literal(1),
  childTaskId: short,
  parentTaskId: short.nullable(),
  rootTaskId: short,
  resultRevision: z.string().length(64),
  status: z.enum(['done', 'failed', 'stopped', 'merged', 'discarded', 'queued', 'running']),
  integration: z.enum(['unapplied', 'shared-parent', 'integrated']),
  verification: z.enum(['passed', 'failed', 'stale', 'not-run']),
  observed: z.boolean(),
  effects: z
    .array(z.object({ id: short, path: z.string().max(4096), digest: z.string().max(128) }))
    .max(32),
  checks: z
    .array(
      z.object({
        id: short,
        command: z.string().max(500),
        state: z.enum(['passed', 'failed', 'stale']),
        digest: z.string().max(128)
      })
    )
    .max(8),
  sourceIds: z.array(short).max(32),
  unresolved: z.array(z.string().max(300)).max(8),
  omitted: z.number().int().nonnegative()
})
export type ChildOutcome = z.infer<typeof ChildOutcomeSchema>
/** Metadata is observed independently of whether the child narrative is true. */
export function childOutcomeText(receipt: ChildOutcome): string {
  return (
    `Child task ${receipt.childTaskId}, root ${receipt.rootTaskId}, parent ${receipt.parentTaskId ?? 'none'}: ${receipt.status}. ` +
    `Integration: ${receipt.integration}. Recorded checks: ${receipt.verification}. ` +
    `Effect evidence: ${receipt.observed ? 'source-backed' : 'unverified'}. ` +
    `Observed paths: ${receipt.effects.map((effect) => effect.path).join(', ') || 'none'}. ` +
    `Unresolved: ${receipt.unresolved.join('; ') || 'none recorded'}. ` +
    `Omitted units: ${receipt.omitted}. Child narrative is unverified; these are historical observations, not proof of current workspace correctness.`
  )
}
