import { z } from 'zod'
export const ThreadWorkingStateSchema = z.object({
  version: z.literal(1),
  taskId: z.string().max(256),
  taskRevision: z.number().int().nonnegative(),
  sourceMessageId: z.string().max(256),
  projectRoot: z.string().max(4096).nullable(),
  terminal: z.string().max(64),
  obligations: z
    .array(
      z.object({
        id: z.string().max(256),
        text: z.string().max(300),
        state: z.enum(['pending', 'effect-observed']),
        effectIds: z.array(z.string().max(256)).max(16)
      })
    )
    .max(32),
  effects: z
    .array(
      z.object({
        id: z.string().max(256),
        path: z.string().max(4096),
        operation: z.string().max(32),
        digest: z.string().max(128)
      })
    )
    .max(64),
  checks: z
    .array(
      z.object({
        id: z.string().max(256),
        command: z.string().max(500),
        state: z.enum(['passed', 'failed', 'stale']),
        digest: z.string().max(128)
      })
    )
    .max(16),
  questions: z
    .array(z.object({ id: z.string().max(256), text: z.string().max(300), answered: z.boolean() }))
    .max(8),
  omitted: z.number().int().nonnegative()
})
export type ThreadWorkingState = z.infer<typeof ThreadWorkingStateSchema>
/** Evidence, never a completion authority. Counts and omitted ranges remain explicit. */
export function workingStateText(state: ThreadWorkingState): string {
  return (
    `Task ${state.taskId} revision ${state.taskRevision}, terminal ${state.terminal}. ` +
    `Observed effects: ${
      state.effects
        .slice(0, 8)
        .map((e) => `${e.path} (${e.operation})`)
        .join('; ') || 'none'
    }. ` +
    `Checks: ${
      state.checks
        .slice(0, 6)
        .map((c) => `${c.command}: ${c.state}`)
        .join('; ') || 'not run'
    }. ` +
    `Obligations: ${
      state.obligations
        .slice(0, 8)
        .map((o) => `${o.id}: ${o.state} — ${o.text.slice(0, 70)}`)
        .join('; ') || 'none recorded'
    }. ` +
    `Open questions: ${
      state.questions
        .filter((q) => !q.answered)
        .map((q) => q.text.slice(0, 80))
        .join('; ') || 'none recorded'
    }. ` +
    `Omitted units: ${state.omitted + Math.max(0, state.effects.length - 8) + Math.max(0, state.checks.length - 6) + Math.max(0, state.obligations.length - 8)}. Historical source state; revalidate effects before repeating them. Narrative completion is not proof.`
  )
}
