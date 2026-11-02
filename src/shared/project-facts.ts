import { z } from 'zod'

export const PROJECT_FACT_MAX_CHARS = 2000
export const PROJECT_FACTS_MAX_ACTIVE = 32
/**
 * Revoked and superseded facts kept for provenance. Older ones are pruned on the next
 * save, so churn can never fill the file and block a new promotion.
 */
export const PROJECT_FACTS_MAX_HISTORY = 200
/** Largest fact file read. Active plus history at full length is far below this. */
export const PROJECT_FACTS_MAX_FILE_BYTES = 8 * 1024 * 1024

const ProjectFactSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().min(1).max(PROJECT_FACT_MAX_CHARS),
    /** The pin the user promoted, and the conversation it lives in. */
    provenance: z
      .object({
        kind: z.literal('user-promoted'),
        threadId: z.string().min(1).max(256),
        pinId: z.string().min(1).max(256)
      })
      .strict(),
    promotedAt: z.number().int().nonnegative(),
    status: z.enum(['active', 'revoked', 'superseded']),
    endedAt: z.number().int().nonnegative().optional(),
    supersededBy: z.string().uuid().optional()
  })
  .strict()
export type ProjectFact = z.infer<typeof ProjectFactSchema>

export const ProjectFactFileSchema = z
  .object({ version: z.literal(1), facts: z.array(ProjectFactSchema).max(1000) })
  .strict()
export type ProjectFactFile = z.infer<typeof ProjectFactFileSchema>
