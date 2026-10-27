import { z } from 'zod'
import { ChatIntentSchema, AgentToolsCeilingSchema } from '../../../src/shared/settings-schema'
import { taskContractConflicts, type TaskContract } from '../../../src/shared/task-contract'
const text = z.string().max(128000),
  path = z.string().max(4096),
  id = z.string().min(1).max(256)
const recommendation = z
  .object({
    id,
    text,
    source: z.string().max(128),
    targets: z.array(path).max(100).optional(),
    section: z.string().max(512).optional()
  })
  .passthrough()
const interpretation = z
  .object({
    revision: z.number().int().nonnegative(),
    artifact: z.enum([
      'explanation',
      'code-example',
      'design',
      'plan',
      'review',
      'patch',
      'execution-report'
    ]),
    destination: z.enum(['chat', 'workspace', 'new-project']),
    obligations: z.array(z.object({ id, kind: z.string().max(64), text }).passthrough()).max(100),
    language: z.string().nullable(),
    frameworks: z.array(z.string()).max(100),
    forbidsMutation: z.boolean(),
    constraints: z
      .object({
        edit: z.boolean(),
        verification: z.boolean(),
        execution: z.boolean(),
        commit: z.boolean(),
        external: z.boolean(),
        trace: z
          .array(
            z.object({
              phrase: text,
              effects: z.array(z.enum(['edit', 'verification', 'execution', 'commit', 'external']))
            })
          )
          .max(100)
      })
      .optional(),
    route: z.object({ heuristicRule: z.string(), overrides: z.array(z.string()) })
  })
  .passthrough()
const task = z
  .object({
    version: z.literal(2),
    taskId: id,
    threadId: id.nullable(),
    revision: z.number().int().nonnegative(),
    originalText: text,
    intent: ChatIntentSchema,
    deliverable: z.enum(['answer', 'review', 'plan', 'patch', 'execution-report']),
    scope: z
      .object({
        workspaceRoot: path.nullable(),
        projectRoot: path.nullable(),
        projectId: id.nullable(),
        state: z.enum(['resolved', 'ambiguous', 'missing']),
        candidates: z.array(path).max(100)
      })
      .passthrough(),
    authority: z
      .object({
        tools: AgentToolsCeilingSchema,
        edit: z.boolean(),
        execute: z.enum(['none', 'verification', 'approved']),
        externalEffects: z.boolean()
      })
      .strict(),
    recommendations: z.array(recommendation).max(100),
    acceptanceCriteria: z.array(text).max(100),
    interpretation: interpretation.optional(),
    result: z
      .object({
        terminal: z.enum(['complete', 'incomplete', 'error', 'stopped']),
        offeredRecommendations: z.array(recommendation).max(100),
        changedFiles: z.array(path).max(4096),
        answerDigest: z.string()
      })
      .passthrough()
      .optional()
  })
  .passthrough()
export function parsePersistedTask(value: unknown): TaskContract {
  const parsed = task.parse(value) as unknown as TaskContract
  if (taskContractConflicts(parsed).length)
    throw new Error('Persisted task grants conflicting authority')
  return parsed
}
const common = {
  operationId: z.string().optional(),
  postimage: z
    .object({
      kind: z.enum(['file', 'directory']),
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      dev: z.number().finite(),
      ino: z.number().finite()
    })
    .optional(),
  reversedAt: z.number().finite().optional()
}
const op = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('write'),
    path,
    before: z.string().nullable(),
    after: z.string(),
    ...common
  }),
  z.object({
    kind: z.literal('delete'),
    path,
    before: z.string(),
    wasDirectory: z.boolean(),
    ...common
  }),
  z.object({
    kind: z.literal('rename'),
    from: path,
    to: path,
    before: z.string().nullable(),
    ...common
  }),
  z.object({ kind: z.literal('mkdir'), path, ...common }),
  z.object({ kind: z.literal('binary-create'), path, ...common })
])
export const CheckpointSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    id: z.string().uuid(),
    createdAt: z.number().finite(),
    workspacePath: path,
    owner: z.object({ taskId: id, threadId: id.nullable() }).optional(),
    ops: z.array(op).max(4096)
  })
  .passthrough()
export const AgentRunSchema = z
  .object({
    id,
    requestId: id,
    goal: text,
    agentId: id,
    mode: z.enum(['ask', 'agent']),
    checkpointId: z.string().nullable(),
    status: z.enum(['running', 'done', 'stopped', 'failed', 'incomplete', 'dismissed']),
    step: z.number().int().nonnegative(),
    actionLog: z.array(text).max(10000),
    filesTouched: z.array(path).max(10000),
    startedAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough()
