import { z } from 'zod'
import { EvalCheckSchema, SandboxPathSchema } from './evals'
import { AgentToolsCeilingSchema, ChatIntentSchema, type ChatIntent } from './settings-schema'
import type { TaskContract } from './task-contract'

/**
 * Build & agent diagnostics runs. Every run is labeled with how model output
 * was produced; a scripted or replayed reply is never reported as a real-model
 * result. Artifacts are local; exports are redacted and opt-in for content.
 */
export const DEBUG_RUN_ARTIFACT_VERSION = 1
export const SCRIPTED_ADAPTER_VERSION = 'scripted-v1'
export const LIVE_ADAPTER_VERSION = 'live-v1'

export const DebugRunModeSchema = z.enum(['simulated', 'real-model'])
export type DebugRunMode = z.infer<typeof DebugRunModeSchema>

/** scripted = scenario fixture, recorded = replay of stored replies, live = provider call. */
export type DebugResponseSource = 'scripted' | 'recorded' | 'live'

export const DEBUG_RUN_MODE_LABEL: Record<DebugRunMode, string> = {
  simulated: 'SIMULATED MODEL RESPONSES',
  'real-model': 'REAL MODEL'
}

export function debugRunLabel(mode: DebugRunMode, source: DebugResponseSource): string {
  if (source === 'recorded')
    return `${DEBUG_RUN_MODE_LABEL.simulated} · REPLAY OF RECORDED RESPONSES`
  return DEBUG_RUN_MODE_LABEL[mode]
}

export const DebugModelPurposeSchema = z.enum(['agent', 'route', 'intent', 'outcome', 'inline'])
export type DebugModelPurpose = z.infer<typeof DebugModelPurposeSchema>

export const ScriptedModelTurnSchema = z.object({
  text: z.string().default(''),
  /** Provider-native tool calls, delivered when the request offered native tools. */
  nativeToolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
    .optional(),
  /** Fail this model call with a provider error instead of replying. */
  error: z.string().optional(),
  /** Never reply; only cancellation or the case deadline ends the call. */
  hang: z.boolean().optional()
})
export type ScriptedModelTurn = z.infer<typeof ScriptedModelTurnSchema>

export const ScriptedVerifySchema = z.object({
  ok: z.boolean(),
  command: z.string().default('npm test'),
  detail: z.string().default('')
})

export const BlockedEffectKindSchema = z.enum([
  'command',
  'verify',
  'web',
  'mcp',
  'image',
  'delegation',
  'cloud'
])
export type BlockedEffectKind = z.infer<typeof BlockedEffectKindSchema>

export const DebugScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /** Injected-failure scripts are simulation only; curated tasks may also run live. */
  modes: z.array(DebugRunModeSchema).min(1).default(['simulated']),
  request: z.object({
    text: z.string().min(1),
    mode: z.enum(['ask', 'agent']).default('agent')
  }),
  /** Disposable project: sandbox-relative path → content. */
  fixture: z.record(SandboxPathSchema, z.string()).default({}),
  expect: z.object({
    /** Any of these intents is acceptable. */
    intent: z.array(ChatIntentSchema).min(1).optional(),
    agentId: z.string().optional(),
    mutation: z.enum(['required', 'forbidden', 'any']).default('any'),
    /** Changes must stay within these paths; a trailing `/` allows a directory. */
    allowedPaths: z.array(SandboxPathSchema).optional(),
    requiredPaths: z.array(SandboxPathSchema).default([]),
    /** Deterministic file/answer checks. Host commands never run in diagnostics. */
    checks: z
      .array(EvalCheckSchema)
      .default([])
      .refine((checks) => checks.every((check) => check.type !== 'command'), {
        message: 'Diagnostics scenarios cannot run command checks'
      }),
    maxToolErrors: z.number().int().nonnegative().optional(),
    terminal: z.enum(['complete', 'incomplete', 'error']).optional(),
    /** Effects the scenario expects Eris to refuse. */
    blockedEffects: z.array(BlockedEffectKindSchema).default([])
  }),
  script: z
    .object({
      agent: z.array(ScriptedModelTurnSchema).default([]),
      route: z.array(ScriptedModelTurnSchema).default([]),
      intent: z.array(ScriptedModelTurnSchema).default([]),
      outcome: z.array(ScriptedModelTurnSchema).default([]),
      verify: z.array(ScriptedVerifySchema).default([])
    })
    .default({}),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000)
})
export type DebugScenario = z.infer<typeof DebugScenarioSchema>
export type DebugScenarioInput = z.input<typeof DebugScenarioSchema>

export interface DebugScenarioInfo {
  id: string
  title: string
  description: string
  tags: string[]
  modes: DebugRunMode[]
  expectedIntents: ChatIntent[]
  mutation: 'required' | 'forbidden' | 'any'
  hash: string
}

export const DebugRunRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('simulated'),
    scenarioIds: z.array(z.string().min(1)).min(1).max(100)
  }),
  z.object({
    mode: z.literal('real-model'),
    scenarioIds: z.array(z.string().min(1)).min(1).max(50),
    model: z.string().min(1),
    /** Live runs make provider calls; the renderer must confirm that explicitly. */
    acknowledgeLiveCalls: z.literal(true),
    /** Store raw model replies locally so the run can be replayed without new calls. */
    captureResponses: z.boolean().default(false)
  })
])
export type DebugRunRequest = z.input<typeof DebugRunRequestSchema>

export const DebugReplayRequestSchema = z.object({
  runId: z.string().min(1),
  caseIds: z.array(z.string().min(1)).max(100).optional()
})
export type DebugReplayRequest = z.infer<typeof DebugReplayRequestSchema>

export const DebugExportRequestSchema = z.object({
  runId: z.string().min(1),
  /** Raw model replies and final answers; off by default. */
  includeResponses: z.boolean().default(false)
})
export type DebugExportRequest = z.input<typeof DebugExportRequestSchema>

/** Shown before saving so the developer sees exactly what an export contains. */
export interface DebugExportPreview {
  label: string
  cases: number
  responses: number
  includesResponses: boolean
  bytes: number
  contents: string[]
}

/** Pipeline stage that failed, in execution order. */
export const DEBUG_FAILURE_STAGES = [
  'setup',
  'route',
  'model',
  'tool_protocol',
  'tool_execution',
  'workspace_effects',
  'verification',
  'answer',
  'outcome_review',
  'lifecycle'
] as const
export type DebugFailureStage = (typeof DEBUG_FAILURE_STAGES)[number]

/** Stable categories shared with exports and future telemetry/recovery reporting. */
export type DebugFailureCategory =
  | 'fixture_invalid'
  | 'intent_mismatch'
  | 'agent_mismatch'
  | 'provider_error'
  | 'script_exhausted'
  | 'tool_schema_invalid'
  | 'tool_unavailable'
  | 'tool_failed'
  | 'mutation_not_applied'
  | 'unexpected_mutation'
  | 'scope_violation'
  | 'required_path_missing'
  | 'check_failed'
  | 'verification_failed'
  | 'blocked_effect_missing'
  | 'terminal_mismatch'
  | 'outcome_unsupported'
  | 'timed_out'
  | 'user_cancelled'
  | 'internal_error'

export type DebugCaseStatus = 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'error'

/** How the agent run itself ended, independent of the oracle. */
export type DebugTerminalState = 'complete' | 'incomplete' | 'error' | 'stopped'

export interface DebugOracleCheck {
  stage: DebugFailureStage
  name: string
  ok: boolean
  expected: string
  actual: string
  category?: DebugFailureCategory
}

export interface DebugModelCall {
  seq: number
  purpose: DebugModelPurpose
  model: string
  source: DebugResponseSource
  /** Hashes identify prompts and replies without storing their text. */
  promptHash: string
  promptChars: number
  responseHash: string
  responseChars: number
  nativeToolCalls: number
  durationMs: number
  /** Index in the scenario/recorded script for this purpose. */
  scriptIndex?: number
  /** True when no scripted reply remained and an empty reply was returned. */
  exhausted?: boolean
  error?: string
}

export type DebugTimelineKind =
  | 'route'
  | 'contract'
  | 'model_call'
  | 'tool'
  | 'diff'
  | 'status'
  | 'recovery'
  | 'verification'
  | 'blocked_effect'
  | 'approval'
  | 'outcome_review'
  | 'answer'
  | 'terminal'
  | 'error'

export interface DebugTimelineEvent {
  seq: number
  /** Milliseconds since the case started. */
  atMs: number
  kind: DebugTimelineKind
  stage: DebugFailureStage
  summary: string
  /** Redacted, bounded diagnostics. File contents are never stored here. */
  detail?: string
}

export interface DebugRouteRecord {
  expectedIntents: ChatIntent[]
  initialIntent: ChatIntent
  semanticIntent: ChatIntent
  intent: ChatIntent
  classifiedIntent?: ChatIntent
  agentId: string
  agentName: string
  toolPolicy: z.infer<typeof AgentToolsCeilingSchema>
  method: string
  reason: string
  chatModel: string
  toolsModel: string
}

export interface DebugContractRecord {
  deliverable: TaskContract['deliverable']
  authority: TaskContract['authority']
  scopeState: TaskContract['scope']['state']
  acceptanceCriteria: string[]
}

export interface DebugCaseResult {
  runId: string
  /** Stable within a run: `<index>-<scenarioId>`. */
  caseId: string
  index: number
  scenarioId: string
  scenarioTitle: string
  scenarioHash: string
  mode: DebugRunMode
  responseSource: DebugResponseSource
  status: DebugCaseStatus
  failure?: { stage: DebugFailureStage; category: DebugFailureCategory; detail: string }
  route: DebugRouteRecord | null
  contract: DebugContractRecord | null
  terminal: DebugTerminalState | null
  changedPaths: string[]
  diffHash: string | null
  outcomeReview: { verdict: string; reason: string } | null
  checks: DebugOracleCheck[]
  modelCalls: DebugModelCall[]
  blockedEffects: Array<{ kind: BlockedEffectKind; detail: string }>
  steps: number
  toolCalls: number
  toolErrors: number
  answerChars: number
  answerHash: string
  timeline: DebugTimelineEvent[]
  timelineTruncated: boolean
  warnings: string[]
  durationMs: number
  startedAt: string
  finishedAt: string
}

/** Raw model replies and answers, kept in a separate local file for replay. */
export type DebugRecordedResponse =
  | {
      caseId: string
      kind: 'model'
      seq: number
      purpose: DebugModelPurpose
      text: string
      nativeToolCalls?: Array<{ id: string; name: string; arguments: string }>
      error?: string
      hang?: boolean
    }
  | { caseId: string; kind: 'answer'; text: string }

export type DebugRunStatus = 'running' | 'completed' | 'cancelled' | 'error'
export type DebugRunVerdict = 'PASS' | 'FAIL' | 'CANCELLED' | 'INCOMPLETE'

export interface DebugRunSummary {
  artifactVersion: typeof DEBUG_RUN_ARTIFACT_VERSION
  runId: string
  mode: DebugRunMode
  responseSource: DebugResponseSource
  /** Always shown with results: SIMULATED MODEL RESPONSES or REAL MODEL. */
  label: string
  replayOf?: string
  status: DebugRunStatus
  verdict: DebugRunVerdict | null
  model: {
    ref: string
    adapter: string
    provider: string
    temperature: number
    contextWindow: number
  }
  pipeline: string
  suiteHash: string
  scenarioIds: string[]
  planned: number
  completed: number
  passed: number
  failed: number
  timedOut: number
  cancelled: number
  errored: number
  byCategory: Partial<Record<DebugFailureCategory, number>>
  byStage: Partial<Record<DebugFailureStage, number>>
  captureResponses: boolean
  app: { version: string; platform: string; arch: string }
  limitations: string[]
  startedAt: string
  finishedAt?: string
  durationMs?: number
  error?: string
}

export interface DebugRunDetail {
  summary: DebugRunSummary
  cases: DebugCaseResult[]
  /** Present only when replies were stored locally (always for simulated runs). */
  responses: DebugRecordedResponse[]
}

export type DebugRunProgressEvent =
  | { type: 'start'; seq: number; summary: DebugRunSummary }
  | { type: 'case-start'; seq: number; runId: string; index: number; scenarioId: string }
  | { type: 'case-status'; seq: number; runId: string; index: number; text: string }
  | {
      type: 'case-result'
      seq: number
      runId: string
      result: DebugCaseResult
      summary: DebugRunSummary
    }
  | { type: 'done'; seq: number; summary: DebugRunSummary }

/** Overall verdict: never PASS unless every planned case ran and passed. */
export function debugRunVerdict(
  summary: Pick<
    DebugRunSummary,
    'status' | 'planned' | 'completed' | 'passed' | 'failed' | 'timedOut' | 'errored'
  >
): DebugRunVerdict | null {
  if (summary.status === 'running') return null
  if (summary.status === 'cancelled') return 'CANCELLED'
  if (summary.failed + summary.timedOut + summary.errored > 0) return 'FAIL'
  if (summary.status !== 'completed' || summary.completed < summary.planned) return 'INCOMPLETE'
  return summary.passed === summary.planned ? 'PASS' : 'INCOMPLETE'
}
