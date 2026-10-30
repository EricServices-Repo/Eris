import { z } from 'zod'
export const ContextEvidenceSchema = z.object({
  version: z.literal(1),
  root: z.string().max(4096),
  repository: z.string().max(1024),
  complete: z.boolean(),
  files: z
    .array(
      z.object({
        path: z.string().max(4096),
        digest: z.string().max(128),
        bytes: z.number().int().nonnegative()
      })
    )
    .max(32),
  epoch: z
    .object({
      workspace: z.number().int().nonnegative(),
      floor: z.number().int().nonnegative(),
      paths: z.array(z.tuple([z.string().max(4096), z.number().int().nonnegative()])).max(32),
      dirty: z.boolean()
    })
    .optional()
})
export type ContextEvidence = z.infer<typeof ContextEvidenceSchema>
