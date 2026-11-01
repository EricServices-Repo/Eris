import { ChildOutcomeSchema } from './child-outcome'
import { ThreadWorkingStateSchema } from './thread-working-state'
import { z } from 'zod'
import type { ChatMessage } from './settings-schema'
import { ContextEvidenceSchema } from './context-evidence'
const ContextRecordSchema = z.object({
  id: z.string().min(1).max(256),
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  createdAt: z.number().finite().default(0),
  contextContentOffset: z.number().int().nonnegative().optional(),
  contextContentLength: z.number().int().nonnegative().optional(),
  contextProjectRoot: z.string().max(4096).nullable().optional(),
  contextSequence: z.number().int().nonnegative().optional(),
  agentId: z.string().max(256).optional(),
  agentName: z.string().max(512).optional(),
  model: z.string().max(512).optional(),
  contextResult: z
    .object({
      workingState: ThreadWorkingStateSchema.optional(),
      childOutcome: ChildOutcomeSchema.optional(),
      taskId: z.string().min(1).max(256),
      terminal: z.string().min(1).max(64),
      projectRoot: z.string().max(4096).nullable(),
      dependencies: ContextEvidenceSchema.optional(),
      changedFiles: z.array(z.string().max(4096)).max(10000)
    })
    .optional()
})
/** Trace/assets are deliberately not part of the recall projection. Invalid rows remain on disk. */
export function contextRecord(value: unknown): ChatMessage | null {
  const parsed = ContextRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
