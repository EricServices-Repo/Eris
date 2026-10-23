import { interpretationOf, type TaskContract } from '../../../../src/shared/task-contract'
import { caseOutcome, coverageOf, evaluationOf, outcomeClass, timeoutEvidence } from './evaluation'
import { createHash, randomUUID } from 'crypto'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import {
  DEBUG_FAILURE_STAGES,
  DEBUG_RUN_ARTIFACT_VERSION,
  DebugReplayRequestSchema,
  DebugRunRequestSchema,
  LIVE_ADAPTER_VERSION,
  SCRIPTED_ADAPTER_VERSION,
  debugRunLabel,
  debugRunVerdict,
  type BlockedEffectKind,
  type DebugCaseResult,
  type DebugCaseStatus,
  type DebugContractRecord,
  type DebugFailureCategory,
  type DebugFailureStage,
  type DebugModelCall,
  type DebugOracleCheck,
  type DebugRecordedResponse,
  type DebugResponseSource,
  type DebugRouteRecord,
  type DebugRunDetail,
  type DebugRunMode,
  type DebugRunProgressEvent,
  type DebugRunSummary,
  type DebugScenario,
  type DebugTerminalState,
  type DebugTimelineEvent,
  type DebugTurnRecord,
  type DebugTimelineKind
} from '../../../../src/shared/debug-runs'
import type {
  AppSettings,
  ChatIntent,
  ChatPromptInput
} from '../../../../src/shared/settings-schema'
import { runAgentWithWorkspaceTools } from '../agent-runner'
import { findAgent } from '../agents'
import {
  buildChatTurnMessages,
  localChatTurnModel,
  needsOutcomeReview,
  OutcomeEvidence,
  planInitialChatTurn,
  resolveChatTurnContract,
  type ChatTurnInput,
  completeChatTurnTask
} from '../chat-turn'
import { materializeSandboxFiles, snapshotWorkspace } from '../eval-runner'
import { logError, logInfo } from '../logger'
import {
  markSimulatedSettings,
  runInDiagnosticsScope,
  SIMULATED_MODEL_REF,
  type DiagnosticsScope,
  type ModelAdapter
} from '../model-transport'
import { SandboxPathError } from '../sandbox-paths'
import { createTaskDeadline, drainUntilStopped } from '../task-deadline'
import { reviewTaskOutcome } from '../task-outcome'
import {
  LiveModelAdapter,
  ScriptedModelAdapter,
  scriptFromRecorded,
  shortHash,
  type RecordedReply,
  type ScriptQueues
} from './model-adapters'
import { evaluateScenario, firstFailure, type ObservedVerification } from './oracle'
import { redactDiagnostic } from './redact'
import { findDebugScenario, scenarioHash } from './scenarios'
import {
  appendCaseResult,
  appendRecordedResponses,
  listDebugRunSummaries,
  pruneDebugRuns,
  readDebugRun,
  writeRunSummary
} from './store'

/** Digest of the sandbox contents; a verification is current only on the same digest. */
function workspaceRevision(root: string): string {
  const files = snapshotWorkspace(root)
  const hash = createHash('sha256')
  for (const path of Object.keys(files).sort()) hash.update(path).update('\0').update(files[path]!)
  return hash.digest('hex').slice(0, 16)
}

export type DebugRunProgressFn = (event: DebugRunProgressEvent) => void

export interface DebugRunDeps {
  /** User-level settings. Workspace settings are never read for a diagnostics run. */
  settings: AppSettings
  getSecret: (key: string) => string | null
  onProgress?: DebugRunProgressFn
}

const PIPELINE =
  'Production chat turn shared with chat IPC: route → semantic intent → task contract → prompt → agent loop → outcome review'
const MAX_TIMELINE = 300

interface CaseSpec {
  scenario: DebugScenario
  /** Scripted/recorded replies; absent for live cases. */
  script?: ScriptQueues
  /** Scripted verification results, consumed in order. */
  verify: DebugScenario['script']['verify']
  /** Model ref the turn is planned with. */
  model: string
}

interface RunPlan {
  mode: DebugRunMode
  source: DebugResponseSource
  model: string
  settings: AppSettings
  cases: CaseSpec[]
  captureResponses: boolean
  replayOf?: string
  warnings: string[]
}

let active: { runId: string; controller: AbortController } | null = null

export function isDebugRunActive(): boolean {
  return Boolean(active && !active.controller.signal.aborted)
}

export function cancelDebugRun(): boolean {
  if (!active) return false
  active.controller.abort()
  return true
}

/** A run left `running` by an earlier app session is reported as interrupted. */
function withLiveStatus(summary: DebugRunSummary): DebugRunSummary {
  return summary.status === 'running' && summary.runId !== active?.runId
    ? {
        ...summary,
        status: 'error',
        verdict: 'INCOMPLETE',
        error: summary.error ?? 'The run was interrupted before it finished.'
      }
    : summary
}

export function listDebugRuns(): DebugRunSummary[] {
  return listDebugRunSummaries().map(withLiveStatus)
}

export function getDebugRun(runId: string): DebugRunDetail | null {
  const detail = readDebugRun(runId)
  return detail ? { ...detail, summary: withLiveStatus(detail.summary) } : null
}

/**
 * Settings for a diagnostics turn. External effects that are not guarded at a
 * transport boundary are disabled here; simulated settings additionally drop
 * every provider connection and carry a marker the provider boundary refuses.
 */
export function diagnosticsSettings(base: AppSettings, simulated: boolean): AppSettings {
  const settings = structuredClone(base)
  settings.images = { ...settings.images, enabled: false }
  settings.evals = { ...settings.evals, useScoresForRouting: false }
  settings.agent = { ...settings.agent, allowedCommands: [] }
  if (!simulated) return settings
  settings.models = {
    ...settings.models,
    connections: [],
    defaultModel: SIMULATED_MODEL_REF
  }
  return markSimulatedSettings(settings)
}

function newRunId(mode: DebugRunMode): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-${randomUUID().slice(0, 8)}`
}

function scenariosFor(ids: string[], mode: DebugRunMode): DebugScenario[] {
  return [...new Set(ids)].map((id) => {
    const scenario = findDebugScenario(id)
    if (!scenario) throw new Error(`Unknown diagnostics scenario “${id}”`)
    if (!scenario.modes.includes(mode))
      throw new Error(`Scenario “${id}” cannot run in ${mode} mode`)
    return scenario
  })
}

function scriptOf(scenario: DebugScenario): ScriptQueues {
  const { agent, route, intent, outcome } = scenario.script
  return { agent, route, intent, outcome }
}

/** Validate a renderer request and run it. Real-model runs require explicit acknowledgement. */
export async function startDebugRun(
  request: unknown,
  deps: DebugRunDeps
): Promise<DebugRunSummary> {
  const parsed = DebugRunRequestSchema.parse(request)
  const scenarios = scenariosFor(parsed.scenarioIds, parsed.mode)
  if (parsed.mode === 'simulated') {
    return executeRun(
      {
        mode: 'simulated',
        source: 'scripted',
        model: SIMULATED_MODEL_REF,
        settings: diagnosticsSettings(deps.settings, true),
        cases: scenarios.map((scenario) => ({
          scenario,
          script: scriptOf(scenario),
          verify: scenario.script.verify,
          model: SIMULATED_MODEL_REF
        })),
        captureResponses: true,
        warnings: []
      },
      deps
    )
  }
  return executeRun(
    {
      mode: 'real-model',
      source: 'live',
      model: parsed.model,
      settings: diagnosticsSettings(deps.settings, false),
      cases: scenarios.map((scenario) => ({ scenario, verify: [], model: parsed.model })),
      captureResponses: parsed.captureResponses ?? false,
      warnings: []
    },
    deps
  )
}

/**
 * Re-run stored model replies against current code. No provider is called,
 * and no approval from the original run is carried forward: every command,
 * MCP, or network effect is refused again at the diagnostics boundary.
 */
export async function replayDebugRun(
  request: unknown,
  deps: DebugRunDeps
): Promise<DebugRunSummary> {
  const parsed = DebugReplayRequestSchema.parse(request)
  const original = readDebugRun(parsed.runId)
  if (!original) throw new Error('Diagnostics run not found')
  const selected = original.cases.filter(
    (item) => !parsed.caseIds || parsed.caseIds.includes(item.caseId)
  )
  if (!selected.length) throw new Error('No matching cases to replay')
  const warnings: string[] = []
  const cases = selected.map((item): CaseSpec => {
    const scenario = findDebugScenario(item.scenarioId)
    if (!scenario) throw new Error(`Scenario “${item.scenarioId}” no longer exists`)
    const replies = original.responses.filter(
      (entry): entry is Extract<DebugRecordedResponse, { kind: 'model' }> =>
        entry.caseId === item.caseId && entry.kind === 'model'
    )
    if (!replies.length)
      throw new Error(
        `Case ${item.caseId} has no stored model replies. Real-model runs store replies only when capture is enabled.`
      )
    if (scenarioHash(scenario) !== item.scenarioHash)
      warnings.push(`${item.scenarioId}: scenario definition changed since the recorded run`)
    return {
      scenario,
      script: scriptFromRecorded(
        replies.map(({ caseId: _caseId, kind: _kind, ...reply }) => reply)
      ),
      // Verification is scripted only when the original run scripted it.
      verify: original.summary.mode === 'simulated' ? scenario.script.verify : [],
      // Plan with the originally selected model so routing reproduces the run.
      model: original.summary.model.ref
    }
  })
  return executeRun(
    {
      mode: 'simulated',
      source: 'recorded',
      model: original.summary.model.ref,
      settings: diagnosticsSettings(deps.settings, true),
      cases,
      captureResponses: true,
      replayOf: original.summary.runId,
      warnings
    },
    deps
  )
}

function limitations(plan: RunPlan): string[] {
  const common = [
    'Runs in a disposable fixture workspace; the selected project is never read or written.',
    'Host commands, verification commands, web access, MCP tools, delegation, and image generation are refused. Verification results are scripted in simulated runs and skipped in real-model runs.',
    'Not exercised: Cloud Composer inline execution, renderer streaming, approval prompts, project memory, and task persistence.',
    "Routing uses this machine's agent roster and learned routing corrections."
  ]
  if (plan.source === 'live')
    return [
      'Model output is nondeterministic; provider state, model version, and rate limits can differ between runs.',
      ...common
    ]
  return [
    plan.source === 'recorded'
      ? 'Replays stored model replies against current code; no provider is called and no prior approval is reused.'
      : 'Model replies are scripted. This validates Eris orchestration and workflow behavior, not model quality.',
    ...common
  ]
}

async function executeRun(plan: RunPlan, deps: DebugRunDeps): Promise<DebugRunSummary> {
  if (active) throw new Error('A diagnostics run is already in progress')
  const controller = new AbortController()
  const runId = newRunId(plan.mode)
  active = { runId, controller }
  let seq = 0
  const emit = (event: DebugRunProgressEvent) => {
    try {
      deps.onProgress?.(event)
    } catch {
      /* progress is best-effort */
    }
  }
  const started = Date.now()
  const summary: DebugRunSummary = {
    artifactVersion: DEBUG_RUN_ARTIFACT_VERSION,
    runId,
    mode: plan.mode,
    responseSource: plan.source,
    label: debugRunLabel(plan.mode, plan.source),
    ...(plan.replayOf ? { replayOf: plan.replayOf } : {}),
    status: 'running',
    verdict: null,
    model: {
      ref: plan.model,
      adapter: plan.source === 'live' ? LIVE_ADAPTER_VERSION : SCRIPTED_ADAPTER_VERSION,
      provider: plan.source === 'live' ? 'configured provider' : 'none (scripted)',
      temperature: plan.settings.models.temperature,
      contextWindow: plan.settings.models.contextWindow
    },
    pipeline: PIPELINE,
    suiteHash: shortHash(plan.cases.map((item) => scenarioHash(item.scenario)).join(',')),
    scenarioIds: plan.cases.map((item) => item.scenario.id),
    planned: plan.cases.length,
    completed: 0,
    passed: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
    errored: 0,
    byCategory: {},
    byStage: {},
    captureResponses: plan.captureResponses,
    app: { version: app.getVersion(), platform: process.platform, arch: process.arch },
    limitations: [...limitations(plan), ...plan.warnings],
    startedAt: new Date(started).toISOString()
  }
  try {
    writeRunSummary(summary)
  } catch (error) {
    active = null
    throw error
  }
  emit({ type: 'start', seq: ++seq, summary: { ...summary } })
  const results: DebugCaseResult[] = []
  try {
    for (const [index, spec] of plan.cases.entries()) {
      if (controller.signal.aborted) break
      emit({ type: 'case-start', seq: ++seq, runId, index, scenarioId: spec.scenario.id })
      const { result, responses } = await runCase(
        runId,
        index,
        spec,
        plan,
        deps,
        controller.signal,
        (text) => emit({ type: 'case-status', seq: ++seq, runId, index, text })
      )
      appendCaseResult(result)
      if (plan.captureResponses) appendRecordedResponses(runId, responses)
      results.push(result)
      const outcome = result.outcomeClass ?? 'ungraded'
      summary.outcomes = { ...summary.outcomes, [outcome]: (summary.outcomes?.[outcome] ?? 0) + 1 }
      summary.coverage = coverageOf(
        plan.cases.map((item) => item.scenario),
        results
      )
      summary.completed += 1
      if (result.status === 'passed') summary.passed += 1
      else if (result.status === 'failed') summary.failed += 1
      else if (result.status === 'timed_out') summary.timedOut += 1
      else if (result.status === 'cancelled') summary.cancelled += 1
      else summary.errored += 1
      if (result.failure) {
        summary.byCategory[result.failure.category] =
          (summary.byCategory[result.failure.category] ?? 0) + 1
        summary.byStage[result.failure.stage] = (summary.byStage[result.failure.stage] ?? 0) + 1
      }
      writeRunSummary(summary)
      emit({ type: 'case-result', seq: ++seq, runId, result, summary: { ...summary } })
    }
    summary.status = controller.signal.aborted ? 'cancelled' : 'completed'
  } catch (error) {
    summary.status = controller.signal.aborted ? 'cancelled' : 'error'
    summary.error = error instanceof Error ? error.message : String(error)
    logError('Diagnostics run failed', { runId, error: summary.error })
  } finally {
    summary.finishedAt = new Date().toISOString()
    summary.durationMs = Date.now() - started
    summary.verdict = debugRunVerdict(summary)
    try {
      writeRunSummary(summary)
    } finally {
      active = null
      try {
        pruneDebugRuns()
      } catch {
        /* retention is best-effort */
      }
    }
    emit({ type: 'done', seq: ++seq, summary: { ...summary } })
  }
  logInfo('Diagnostics run finished', {
    runId,
    mode: summary.mode,
    source: summary.responseSource,
    verdict: summary.verdict,
    passed: summary.passed,
    planned: summary.planned
  })
  return summary
}

class Timeline {
  readonly events: DebugTimelineEvent[] = []
  truncated = false
  private seq = 0

  constructor(
    private readonly started: number,
    private sandbox: string | null = null
  ) {}

  setSandbox(path: string): void {
    this.sandbox = path
  }

  add(kind: DebugTimelineKind, stage: DebugFailureStage, summary: string, detail?: string): void {
    if (this.events.length >= MAX_TIMELINE) {
      this.truncated = true
      return
    }
    this.events.push({
      seq: ++this.seq,
      atMs: Date.now() - this.started,
      kind,
      stage,
      summary: redactDiagnostic(summary, this.sandbox, 240),
      ...(detail ? { detail: redactDiagnostic(detail, this.sandbox) } : {})
    })
  }
}

function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort()
}

async function runCase(
  runId: string,
  index: number,
  spec: CaseSpec,
  plan: RunPlan,
  deps: DebugRunDeps,
  runSignal: AbortSignal,
  onStatus: (text: string) => void
): Promise<{ result: DebugCaseResult; responses: DebugRecordedResponse[] }> {
  const { scenario } = spec
  const caseId = `${index + 1}-${scenario.id}`
  const started = Date.now()
  const timeline = new Timeline(started)
  const calls: DebugModelCall[] = []
  const replies: RecordedReply[] = []
  const blocked: Array<{ kind: BlockedEffectKind; detail: string }> = []
  const warnings: string[] = []
  const verifyQueue = [...spec.verify]
  // Every verification result the harness returned, so pass claims can be checked.
  const verifications: ObservedVerification[] = []
  // Changed files after the case, kept after the sandbox is removed.
  const artifacts: DebugRecordedResponse[] = []
  const sink = (call: DebugModelCall, reply: RecordedReply) => {
    calls.push(call)
    replies.push(reply)
    timeline.add(
      'model_call',
      'model',
      `${call.purpose} model call · ${call.source}${call.exhausted ? ' · no scripted reply left' : ''}${call.nativeToolCalls ? ` · ${call.nativeToolCalls} native tool call(s)` : ''}`,
      call.error
    )
  }
  const adapter: ModelAdapter = spec.script
    ? new ScriptedModelAdapter(
        spec.script,
        plan.source === 'recorded' ? 'recorded' : 'scripted',
        sink
      )
    : new LiveModelAdapter(sink)
  const scope: DiagnosticsScope = {
    runId,
    mode: plan.mode,
    adapter,
    onBlockedEffect: (kind, detail) => {
      blocked.push({ kind, detail: redactDiagnostic(detail, sandbox, 240) })
      timeline.add(
        'blocked_effect',
        'tool_execution',
        `${kind} refused by the diagnostics boundary`,
        detail
      )
    },
    verify: ({ root, preferTypecheck }) => {
      const next = verifyQueue.shift()
      // Bound to the command and the workspace revision it ran against.
      verifications.push({
        ok: next?.ok ?? true,
        skipped: !next,
        // The whole sandbox, not the command's project folder, so it compares with the final digest.
        ...(next ? { command: next.command, revision: workspaceRevision(sandbox ?? root) } : {})
      })
      if (!next) {
        scope.onBlockedEffect('verify', 'No scripted verification result; verify was skipped')
        return {
          ok: true,
          skipped: true,
          command: '',
          detail: 'Diagnostics run: verification commands are disabled; verify was skipped.'
        }
      }
      timeline.add(
        'verification',
        'verification',
        `${preferTypecheck ? 'mid-run' : 'final'} verify (scripted) ${next.ok ? 'passed' : 'failed'}`,
        `${next.command}\n${next.detail}`
      )
      return { ok: next.ok, command: next.command, detail: next.detail }
    },
    // Delegation and recovery decisions are evidence; keep them in the timeline.
    onTaskEvent: (event) => {
      if (event.type === 'delegation') {
        const data = event.data as { agentId?: string; status?: string }
        timeline.add('status', 'tool_execution', `delegation ${data.agentId}: ${data.status}`)
      } else if (event.type === 'reroute' || event.type === 'reroute-refused') {
        const data = event.data as { from?: string; to?: string; reason?: string }
        timeline.add(
          'recovery',
          'tool_protocol',
          event.type === 'reroute'
            ? `re-route ${data.from} → ${data.to}; task, project and authority kept`
            : `re-route refused: ${data.reason}`
        )
      }
    }
  }
  const deadline = createTaskDeadline(runSignal, scenario.timeoutMs)
  // Assigned inside the scoped pipeline closure; keep the declared unions.
  let sandbox = null as string | null
  let route = null as DebugRouteRecord | null
  let contract = null as DebugContractRecord | null
  let terminal = null as DebugTerminalState | null
  let status = 'passed' as DebugCaseStatus
  let failure = undefined as DebugCaseResult['failure']
  let answer = ''
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  const toolFailureCodes: string[] = []
  const toolsUsed = new Set<string>()
  let actionLog: string[] = []
  let outcomeReview = null as DebugCaseResult['outcomeReview']
  let changedPaths: string[] = []
  let diffHash: string | null = null
  let checks: DebugCaseResult['checks'] = []
  let agentError = null as string | null
  let before = null as Record<string, string> | null
  // Multi-turn cases: per-turn records and the oracle checks of every turn but the last.
  const turns = [
    { text: scenario.request.text, mode: scenario.request.mode, expect: scenario.expect },
    ...scenario.followUps.map((turn) => ({
      text: turn.text,
      mode: turn.mode ?? scenario.request.mode,
      expect: turn.expect
    }))
  ]
  const multiTurn = turns.length > 1
  const turnRecords: DebugTurnRecord[] = []
  const earlierChecks: DebugOracleCheck[] = []
  let lastExpect = scenario.expect
  let turnBefore = null as Record<string, string> | null
  let turnChanged: string[] = []
  let turnAfter: Record<string, string> | undefined
  let turnVerificationStart = 0
  const fail = (stage: DebugFailureStage, category: DebugFailureCategory, detail: string) => {
    failure = { stage, category, detail: redactDiagnostic(detail, sandbox) }
    timeline.add('error', stage, `${category}: ${detail}`)
  }
  // Workspace effects are evidence even when the case stops early.
  const captureChanges = () => {
    if (!sandbox || !before) return
    const after = snapshotWorkspace(sandbox)
    changedPaths = changedFiles(before, after)
    const prior = before
    artifacts.splice(
      0,
      artifacts.length,
      ...changedPaths.map((path): DebugRecordedResponse => {
        const content = after[path]
        return {
          caseId,
          kind: 'artifact',
          path,
          beforeHash: prior[path] === undefined ? null : shortHash(prior[path]!),
          afterHash: content === undefined ? null : shortHash(content),
          after: content === undefined ? null : redactDiagnostic(content, sandbox, 20_000),
          truncated: content !== undefined && content.length > 20_000
        }
      })
    )
    diffHash = changedPaths.length
      ? shortHash(changedPaths.map((path) => `${path}:${shortHash(after[path] ?? '')}`).join('\n'))
      : null
  }
  try {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'eris-diagnostics-')))
    timeline.setSandbox(sandbox)
    try {
      materializeSandboxFiles(sandbox, scenario.fixture)
    } catch (error) {
      if (!(error instanceof SandboxPathError)) throw error
      status = 'error'
      fail('setup', 'fixture_invalid', error.message)
      throw error
    }
    before = snapshotWorkspace(sandbox)
    const caseSandbox = sandbox
    const history: ChatPromptInput['history'] = []
    let priorTask: TaskContract | null = null
    const stopped = await runInDiagnosticsScope(scope, async () => {
      for (const [turnIndex, turn] of turns.entries()) {
        lastExpect = turn.expect
        turnVerificationStart = verifications.length
        turnBefore = snapshotWorkspace(caseSandbox)
        answer = ''
        terminal = null
        if (multiTurn) timeline.add('status', 'lifecycle', `turn ${turnIndex + 1}: ${turn.text}`)
        // Follow-ups share the thread, sandbox and the previous turn's task, as chat does.
        const turnInput: ChatTurnInput = {
          requestId: `diagnostics-${runId}-${index + 1}${multiTurn ? `-t${turnIndex + 1}` : ''}`,
          workspacePath: caseSandbox,
          settings: plan.settings,
          text: turn.text,
          model: spec.model,
          mode: turn.mode,
          history: [...history],
          threadId: multiTurn ? `diagnostics-${runId}-${index + 1}` : null,
          skillIds: [],
          getSecret: deps.getSecret,
          signal: deadline.signal,
          priorTask
        }
        onStatus(multiTurn ? `Routing turn ${turnIndex + 1}` : 'Routing')
        const initial = await planInitialChatTurn(turnInput)
        if (initial.error) {
          fail('route', 'provider_error', initial.error)
          return null
        }
        const {
          plan: turnPlan,
          task,
          semanticIntent,
          resolution
        } = await resolveChatTurnContract(turnInput, initial)
        const interpretation = interpretationOf(task)
        route = {
          expectedIntents: (turn.expect.intent ?? []) as ChatIntent[],
          initialIntent: initial.intent,
          semanticIntent,
          intent: turnPlan.intent,
          ...(turnPlan.classifiedIntent ? { classifiedIntent: turnPlan.classifiedIntent } : {}),
          agentId: turnPlan.agentId,
          agentName: turnPlan.agentName,
          toolPolicy: turnPlan.toolPolicy,
          method: turnPlan.method,
          reason: turnPlan.reason,
          chatModel: turnPlan.models.chat,
          toolsModel: turnPlan.models.tools,
          resolution,
          ...(turnPlan.routeTrace ? { routeTrace: turnPlan.routeTrace } : {})
        }
        contract = {
          deliverable: task.deliverable,
          authority: task.authority,
          scopeState: task.scope.state,
          acceptanceCriteria: task.acceptanceCriteria,
          artifact: interpretation.artifact,
          destination: interpretation.destination,
          obligations: interpretation.obligations,
          taskId: task.taskId,
          recommendations: task.recommendations.length,
          recommendationSource: task.continuation?.recommendationSource ?? 'none',
          ...(task.continuation ? { priorChangedFiles: task.continuation.changedFiles } : {})
        }
        timeline.add(
          'route',
          'route',
          `${initial.intent}${semanticIntent !== initial.intent ? ` → ${semanticIntent}` : ''} → ${turnPlan.intent} · ${turnPlan.agentName} · tools ${turnPlan.toolPolicy}`,
          `${turnPlan.reason} · resolver ${resolution.source}:${resolution.rule}${resolution.failure ? ` (${resolution.failure})` : ''}${resolution.downgrade ? ` · ${resolution.downgrade.from} → ${resolution.downgrade.to} by ${resolution.downgrade.rule}` : ''}`
        )
        timeline.add(
          'contract',
          'route',
          `artifact ${interpretation.artifact} → ${interpretation.destination} · deliverable ${task.deliverable} · edit ${task.authority.edit ? 'allowed' : 'denied'} · execute ${task.authority.execute}`
        )
        const prompt: ChatPromptInput = {
          text: turn.text,
          mode: turn.mode,
          agentId: turnPlan.agentId,
          agentName: turnPlan.agentName,
          skillIds: [],
          attachments: [],
          history: [...history]
        }
        const messages = buildChatTurnMessages(sandbox, plan.settings, prompt, turnPlan, null)
        const local = localChatTurnModel(
          turnPlan,
          turnPlan.models.chat || spec.model || plan.settings.models.defaultModel,
          plan.settings
        )
        const temperature =
          findAgent(sandbox, local.plan.agentId)?.temperature ?? plan.settings.models.temperature
        const evidence = new OutcomeEvidence()
        let incomplete = false
        onStatus(`${local.plan.agentName} · ${local.plan.intent}`)
        let ended: Awaited<ReturnType<typeof drainUntilStopped>>
        try {
          ended = await drainUntilStopped(
            runAgentWithWorkspaceTools({
              workspacePath: sandbox,
              settings: plan.settings,
              model: local.model,
              messages,
              temperature,
              signal: deadline.signal,
              getSecret: deps.getSecret,
              mode: turn.mode,
              turnPlan: local.plan,
              mcp: 'off',
              allowDelegate: false,
              // Diagnostics never inherit or grant approvals, including on replay.
              approveCommand: async (kind, command) => {
                scope.onBlockedEffect('command', `${kind}: ${command}`)
                timeline.add(
                  'approval',
                  'tool_execution',
                  `${kind} approval denied (diagnostics)`,
                  command
                )
                return false
              },
              approveMcpTool: async (toolName) => {
                scope.onBlockedEffect('mcp', toolName)
                return false
              }
            }),
            deadline,
            (evt) => {
              evidence.observe(evt)
              if (evt.type === 'answer') answer = evt.replace ? evt.text : answer + evt.text
              else if (evt.type === 'tool') {
                if (evt.tool.status === 'running') return
                toolCalls += 1
                toolsUsed.add(evt.tool.name)
                if (evt.tool.status === 'error') {
                  toolErrors += 1
                  if (evt.tool.failure?.code) toolFailureCodes.push(evt.tool.failure.code)
                }
                timeline.add(
                  'tool',
                  'tool_execution',
                  `${evt.tool.name}${evt.tool.path ? ` ${evt.tool.path}` : ''} · ${evt.tool.status}${evt.tool.failure ? ` · ${evt.tool.failure.code}` : ''}`,
                  // Successful tool output can contain file contents; keep only errors.
                  evt.tool.status === 'error' ? evt.tool.detail : undefined
                )
              } else if (evt.type === 'diff') {
                timeline.add(
                  'diff',
                  'workspace_effects',
                  `${evt.diff.op} ${evt.diff.path}`,
                  `before ${shortHash(evt.diff.before ?? '')} · after ${shortHash(evt.diff.after)}`
                )
              } else if (evt.type === 'progress' || evt.type === 'session-step') {
                steps = evt.step
                actionLog = evt.actionLog.slice(-120)
                if (evt.type === 'progress' && evt.incomplete) incomplete = true
              } else if (evt.type === 'adapt') {
                timeline.add(
                  'recovery',
                  'tool_protocol',
                  `${evt.kind}: ${evt.reason}`,
                  [evt.agentId, evt.model].filter(Boolean).join(' · ') || undefined
                )
              } else if (evt.type === 'status') {
                timeline.add('status', 'lifecycle', evt.text)
              }
            }
          )
        } catch (error) {
          agentError = error instanceof Error ? error.message : String(error)
          terminal = 'error'
          timeline.add('error', 'model', 'agent run failed', agentError)
          return null
        }
        if (ended !== 'completed') return ended
        terminal = incomplete ? 'incomplete' : 'complete'
        if (needsOutcomeReview(local.plan, incomplete)) {
          onStatus('Outcome review')
          evidence.addActions(actionLog)
          const verdict = await reviewTaskOutcome({
            task,
            answer,
            evidence: evidence.items,
            settings: plan.settings,
            model: local.plan.models.chat,
            signal: deadline.signal,
            getSecret: deps.getSecret
          })
          outcomeReview = {
            verdict: verdict.verdict,
            reason: redactDiagnostic(verdict.reason, sandbox)
          }
          timeline.add(
            'outcome_review',
            'outcome_review',
            `outcome ${verdict.verdict}`,
            verdict.reason
          )
          // Same rule as chat: an unsupported outcome leaves the turn incomplete.
          if (verdict.verdict !== 'supported') terminal = 'incomplete'
        }
        const late = deadline.stopReason()
        if (late) return late
        turnAfter = snapshotWorkspace(caseSandbox)
        turnChanged = changedFiles(turnBefore, turnAfter)
        priorTask = completeChatTurnTask(task, {
          answer,
          changedFiles: turnChanged,
          terminal: terminal ?? 'error'
        })
        turnRecords.push({
          turn: turnIndex + 1,
          text: turn.text,
          route,
          contract,
          terminal,
          changedPaths: turnChanged,
          answerChars: answer.length,
          answerHash: shortHash(answer)
        })
        history.push(
          { role: 'user', content: turn.text },
          {
            role: 'assistant',
            content: answer,
            agentId: local.plan.agentId,
            agentName: local.plan.agentName
          }
        )
        if (turnIndex < turns.length - 1) {
          earlierChecks.push(
            ...evaluateScenario({
              scenario: { ...scenario, expect: turn.expect },
              sandbox: caseSandbox,
              route,
              contract,
              terminal,
              beforeWorkspace: turnBefore,
              changedPaths: turnChanged,
              answer,
              steps,
              durationMs: Date.now() - started,
              toolErrors,
              toolFailureCodes,
              toolsUsed: [...toolsUsed],
              blockedEffects: blocked.map((item) => item.kind),
              verifications: verifications.slice(turnVerificationStart),
              finalRevision: workspaceRevision(caseSandbox),
              afterWorkspace: turnAfter
            }).map((item) => ({ ...item, name: `turn ${turnIndex + 1}: ${item.name}` }))
          )
        }
      }
      return null
    })
    captureChanges()
    timeline.add('answer', 'answer', `final answer · ${answer.length} chars · ${shortHash(answer)}`)
    if (stopped) {
      status = stopped === 'timeout' ? 'timed_out' : 'cancelled'
      terminal = 'stopped'
      fail(
        'lifecycle',
        stopped === 'timeout' ? 'timed_out' : 'user_cancelled',
        stopped === 'timeout' ? `Timed out after ${scenario.timeoutMs}ms` : 'Cancelled by the user'
      )
    } else if (!failure) {
      const lastChecks = evaluateScenario({
        scenario: { ...scenario, expect: lastExpect },
        sandbox,
        route,
        contract,
        terminal,
        beforeWorkspace: multiTurn ? (turnBefore ?? before) : before,
        changedPaths: multiTurn ? turnChanged : changedPaths,
        answer,
        steps,
        durationMs: Date.now() - started,
        toolErrors,
        toolFailureCodes,
        toolsUsed: [...toolsUsed],
        blockedEffects: blocked.map((item) => item.kind),
        verifications: verifications.slice(multiTurn ? turnVerificationStart : 0),
        finalRevision: sandbox ? workspaceRevision(sandbox) : undefined,
        afterWorkspace: sandbox ? snapshotWorkspace(sandbox) : undefined
      })
      checks = [
        ...earlierChecks,
        ...(multiTurn
          ? lastChecks.map((item) => ({ ...item, name: `turn ${turns.length}: ${item.name}` }))
          : lastChecks)
      ]
      if (terminal === 'error' && !lastExpect.terminal) {
        const fromModel = calls.some((call) => call.error)
        checks.push({
          stage: fromModel ? 'model' : 'lifecycle',
          name: 'agent run',
          ok: false,
          expected: 'agent run completes',
          actual: redactDiagnostic(agentError ?? 'error', sandbox),
          category: fromModel ? 'provider_error' : 'internal_error'
        })
      }
      const first = firstFailure(checks)
      const exhausted = calls.filter((call) => call.purpose === 'agent' && call.exhausted).length
      if (exhausted)
        warnings.push(
          `The agent asked for ${exhausted} more model repl${exhausted === 1 ? 'y' : 'ies'} than the script provided.`
        )
      if (first) {
        status = 'failed'
        // A route or setup failure stays primary; an exhausted script explains later stages.
        const afterModel =
          DEBUG_FAILURE_STAGES.indexOf(first.stage) > DEBUG_FAILURE_STAGES.indexOf('model')
        if (exhausted && afterModel && plan.source !== 'live')
          fail(
            'model',
            'script_exhausted',
            `${warnings.at(-1)} First failed check: ${first.name} (${first.actual})`
          )
        else
          fail(
            first.stage,
            first.category ?? 'check_failed',
            `${first.name}: expected ${first.expected}; actual ${first.actual}`
          )
      }
    } else {
      status = 'error'
    }
  } catch (error) {
    try {
      captureChanges()
    } catch {
      /* evidence is best-effort after a failure */
    }
    const reason = deadline.stopReason()
    if (reason) {
      status = reason === 'timeout' ? 'timed_out' : 'cancelled'
      terminal = 'stopped'
      fail('lifecycle', reason === 'timeout' ? 'timed_out' : 'user_cancelled', reason)
    } else if (!failure) {
      status = 'error'
      fail('setup', 'internal_error', error instanceof Error ? error.message : String(error))
    }
  } finally {
    deadline.dispose()
    if (sandbox) {
      try {
        rmSync(sandbox, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
  const finished = Date.now()
  const result: DebugCaseResult = {
    runId,
    caseId,
    index,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioHash: scenarioHash(scenario),
    mode: plan.mode,
    responseSource: plan.source,
    status,
    ...(failure ? { failure } : {}),
    route,
    contract,
    terminal,
    ...(multiTurn ? { turns: turnRecords } : {}),
    changedPaths,
    diffHash,
    outcomeReview,
    checks,
    modelCalls: calls,
    blockedEffects: blocked,
    steps,
    toolCalls,
    toolErrors,
    answerChars: answer.length,
    answerHash: shortHash(answer),
    timeline: timeline.events,
    timelineTruncated: timeline.truncated,
    warnings,
    durationMs: finished - started,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString()
  }
  result.outcome = caseOutcome(result)
  if (result.status === 'timed_out' || result.status === 'cancelled')
    result.timeoutEvidence = timeoutEvidence(result)
  result.outcomeClass = outcomeClass(result)
  result.evaluation = evaluationOf(scenario, result)
  const responses: DebugRecordedResponse[] = [
    ...replies.map((reply) => ({ caseId, kind: 'model' as const, ...reply })),
    { caseId, kind: 'answer', text: answer },
    ...artifacts
  ]
  return { result, responses }
}
