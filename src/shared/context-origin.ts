import { z } from 'zod'
/** Host-sealed source/execution mapping. Never render this capability into a model prompt. */
export const ContextOriginSchema = z
  .object({
    version: z.literal(1),
    profile: z.string().length(64),
    sourceRoot: z.string().max(4096).nullable(),
    workspaceId: z.string().max(256).nullable(),
    threadId: z.string().min(1).max(256),
    namespace: z.string().length(64),
    projectRelative: z.string().max(4096).nullable(),
    sourceEpoch: z.string().min(1).max(256),
    controlsRevision: z.number().int().nonnegative(),
    policyDigest: z.string().length(64),
    executionRoot: z.string().max(4096).nullable(),
    executionProject: z.string().max(4096).nullable(),
    taskId: z.string().min(1).max(256),
    seal: z.string().length(64)
  })
  .strict()
export type ContextOrigin = z.infer<typeof ContextOriginSchema>
