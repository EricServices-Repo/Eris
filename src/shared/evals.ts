import { z } from 'zod'
import { ChatIntentSchema, type ChatIntent } from './settings-schema'

export const EvalCheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_contains'), path: z.string(), text: z.string() }),
  z.object({ type: z.literal('file_matches'), path: z.string(), pattern: z.string() }),
  z.object({ type: z.literal('file_exists'), path: z.string() }),
  z.object({ type: z.literal('file_absent'), path: z.string() }),
  z.object({
    type: z.literal('command'),
    command: z.string(),
    expectExit: z.number().int().optional()
  }),
  z.object({ type: z.literal('answer_contains'), text: z.string() }),
  z.object({ type: z.literal('answer_matches'), pattern: z.string() }),
  /** Fails if any fixture file changed, appeared, or disappeared */
  z.object({ type: z.literal('no_changes') })
])
export type EvalCheck = z.infer<typeof EvalCheckSchema>

export const EvalTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  intent: ChatIntentSchema,
  prompt: z.string().min(1),
  /** Starting repo state: relative path → file content */
  files: z.record(z.string()).default({}),
  checks: z.array(EvalCheckSchema).min(1),
  agentId: z.string().optional(),
  mode: z.enum(['ask', 'agent']).default('agent'),
  timeoutMs: z.number().int().positive().max(1_800_000).default(300_000)
})
export type EvalTask = z.infer<typeof EvalTaskSchema>

export interface EvalTaskInfo {
  id: string
  title: string
  intent: ChatIntent
  source: 'builtin' | 'workspace'
  checks: number
}

export interface EvalCheckResult {
  check: EvalCheck
  ok: boolean
  detail: string
}

export interface EvalResult {
  /** Groups results from one Run click / CLI invocation */
  batchId: string
  taskId: string
  taskTitle: string
  source: 'builtin' | 'workspace'
  intent: ChatIntent
  model: string
  agentId: string
  ok: boolean
  checks: EvalCheckResult[]
  steps: number
  toolCalls: number
  toolErrors: number
  durationMs: number
  answer: string
  error?: string
  at: string
}

export interface EvalScore {
  model: string
  intent: ChatIntent
  runs: number
  passed: number
  successRate: number
  avgSteps: number
  avgDurationMs: number
}

export interface EvalScoreboard {
  scores: EvalScore[]
  recent: EvalResult[]
  totalRuns: number
}

export interface EvalRunRequest {
  taskIds: string[]
  models: string[]
  repeats: number
}

export type EvalProgressEvent =
  | { type: 'start'; batchId: string; total: number }
  | { type: 'task-start'; batchId: string; index: number; taskId: string; model: string }
  | { type: 'task-status'; batchId: string; taskId: string; model: string; text: string }
  | { type: 'result'; batchId: string; index: number; result: EvalResult }
  | { type: 'done'; batchId: string; passed: number; total: number; cancelled: boolean }
