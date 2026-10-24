import { z } from 'zod'
import { createHash } from 'crypto'
import { isPathInside, realpathAllowMissing, resolveInWorkspace } from './workspace-fs'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'NUL in path')
const content = z.string().max(1_000_000)
const history = z
  .object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(128_000),
    agentId: z.string().max(128).optional(),
    agentName: z.string().max(256).optional()
  })
  .strict()
export const ChatSubmissionSchema = z
  .object({
    version: z.literal(1).default(1),
    requestId: id,
    model: z.string().min(1).max(512),
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content }).strict())
      .max(200)
      .optional(),
    prompt: z
      .object({
        text: z.string().min(1).max(128_000),
        mode: z.enum(['ask', 'agent']),
        agentId: z.string().max(128),
        agentName: z.string().max(256).optional(),
        skillIds: z.array(z.string().max(256)).max(100),
        openFile: z
          .object({ path, language: z.string().max(128).optional(), content })
          .strict()
          .nullable()
          .optional(),
        attachments: z
          .array(
            z
              .object({
                path,
                name: z.string().max(512),
                language: z.string().max(128).optional(),
                content: content.optional()
              })
              .strict()
          )
          .max(30),
        history: z.array(history).max(200),
        threadId: id.nullable().optional()
      })
      .strict()
      .optional(),
    agentId: z.string().max(128).optional(),
    mode: z.enum(['ask', 'agent']).optional(),
    workspacePath: path.nullable().optional(),
    forceRoute: z.enum(['tools', 'answer']).optional(),
    // Accepted only for older clients. It never owns planning or authority.
    turnPlan: z.unknown().optional(),
    planningDurationMs: z.number().finite().min(0).max(3600000).optional(),
    threadId: id.nullable().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.prompt &&
      !value.messages?.some((item) => item.role === 'user' && item.content.trim())
    )
      ctx.addIssue({ code: 'custom', message: 'A user request is required.' })
    if (value.threadId && value.prompt?.threadId && value.threadId !== value.prompt.threadId)
      ctx.addIssue({ code: 'custom', message: 'Thread references disagree.' })
    if (value.mode && value.prompt && value.mode !== value.prompt.mode)
      ctx.addIssue({ code: 'custom', message: 'Chat modes disagree.' })
  })
export type ChatSubmission = z.infer<typeof ChatSubmissionSchema>

export function parseChatSubmission(input: unknown): ChatSubmission {
  // Bound raw legacy data (including ignored plans) before parsing/copying it.
  if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > 2_000_000)
    throw new Error('Chat submission exceeds 2 MB.')
  return ChatSubmissionSchema.parse(input)
}
export function validateSubmissionPaths(input: ChatSubmission, workspace: string | null): void {
  if (input.workspacePath !== undefined && input.workspacePath !== workspace)
    throw new Error('The workspace changed before submission.')
  const check = (path: string, providedContent = false) => {
    if (providedContent) return // Attached text is data; no disk access is authorized by this path.
    if (!workspace) throw new Error('A workspace is required to read an attached file.')
    const root = realpathAllowMissing(workspace)
    if (!isPathInside(root, realpathAllowMissing(resolveInWorkspace(workspace, path))))
      throw new Error('Attached file is outside the selected workspace.')
  }
  if (input.prompt?.openFile) check(input.prompt.openFile.path)
  for (const attachment of input.prompt?.attachments ?? [])
    check(attachment.path, attachment.content !== undefined)
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)])
    )
  return value
}
export function submissionDigest(input: ChatSubmission, workspace: string | null): string {
  const { turnPlan: _plan, planningDurationMs: _timing, ...request } = input
  return createHash('sha256')
    .update(JSON.stringify(ordered({ ...request, workspacePath: workspace })))
    .digest('hex')
}
