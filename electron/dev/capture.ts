import { randomUUID } from 'crypto'
import { streamProviderChat } from '../main/services/chat-runtime'
import type { PreparedLiveModel } from './models'
import type {
  DevCapture,
  DevQuestion,
  DevResult,
  DevTerminationCause,
  IntentReplyMode
} from '../../src/shared/eris-dev'
import { assessDeliverable, deliverableContext } from '../../src/shared/deliverable-checks'
import type { AppSettings } from '../../src/shared/settings-schema'
import type { IntentResolution, TaskContract } from '../../src/shared/task-contract'
import { interpretationOf } from '../../src/shared/task-contract'
import { getDefaults } from '../main/services/settings'
import {
  runInDiagnosticsScope,
  markSimulatedSettings,
  SIMULATED_MODEL_REF,
  type ModelAdapter
} from '../main/services/model-transport'
import {
  planInitialChatTurn,
  resolveChatTurnContract,
  buildChatTurnMessages
} from '../main/services/chat-turn'
import { runAgentWithWorkspaceTools } from '../main/services/agent-runner'
import { flushTaskLedger } from '../main/services/task-ledger'
import { requestInvariantFindings } from '../main/services/agent/request-invariants'

export interface CaptureOptions {
  live?: PreparedLiveModel
  timeoutMs?: number
  maxCalls?: number
  question?: Partial<DevQuestion>
  intentReplyMode?: IntentReplyMode
}

/** The capture settings: no connections, no images, no commands. Shared with the run header digest. */
export function captureSettings(context: number): AppSettings {
  const settings = markSimulatedSettings(structuredClone(getDefaults()))
  settings.models = {
    ...settings.models,
    connections: [],
    defaultModel: SIMULATED_MODEL_REF,
    contextWindow: context
  }
  settings.images.enabled = false
  settings.agent.allowedCommands = []
  settings.evals.useScoresForRouting = false
  return settings
}

/** A native worker that exited or failed, as opposed to a provider or transport error. */
function isWorkerFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code === 'LOCAL_MODEL_WORKER_FAILED' ||
      error.name === 'LocalModelWorkerError')
  )
}

function describeResolution(resolution: IntentResolution): string {
  const failure = resolution.failure ? ` (${resolution.failure})` : ''
  const change = resolution.downgrade
    ? `: ${resolution.downgrade.from} → ${resolution.downgrade.to} by rule ${resolution.downgrade.rule}`
    : resolution.intent === resolution.initialIntent
      ? `: kept ${resolution.intent}`
      : `: ${resolution.initialIntent} → ${resolution.intent}`
  return `Intent resolver · ${resolution.source}:${resolution.rule}${failure}${change}. No live semantic model was consulted.`
}

/**
 * Run one question through the production chat turn and stop at the model
 * transport boundary. Nothing reaches a provider, and no answer is generated.
 */
export async function captureQuestion(
  index: number,
  question: string,
  workspace: string | null,
  context: number,
  mode: 'ask' | 'agent',
  signal: AbortSignal,
  options: CaptureOptions = {}
): Promise<DevResult> {
  const started = Date.now()
  const controller = new AbortController()
  // The first cause wins: cleanup after a worker crash must not relabel it a timeout.
  let cause: DevTerminationCause | null = null
  let lastProgressAt: number | null = null
  const stop = (reason: DevTerminationCause) => {
    cause ??= reason
    controller.abort(reason)
  }
  const cancel = () => stop('user-cancelled')
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const timeout = setTimeout(
    () => stop('deadline-exceeded'),
    options.live ? (options.timeoutMs ?? 180000) : 30000
  )
  const intentReplyMode = options.intentReplyMode ?? 'fallback'
  const scriptedIntent = options.question?.intentReply
  const result: DevResult = {
    index,
    questionId: options.question?.id ?? `run-${index}`,
    ...(options.question?.variant ? { variant: options.question.variant } : {}),
    sourceLine: options.question?.sourceLine ?? index + 1,
    question,
    status: 'blocked',
    stages: {
      reachability: 'blocked',
      requestValidity: 'not-assessed',
      inference: 'not-run',
      answerQuality: 'not-evaluated'
    },
    calls: 0,
    findings: { defect: 0, review: 0 },
    findingIds: [],
    requests: [],
    response: null,
    responseReason: 'not-generated',
    sourceMode: 'capture',
    intentReplySource: 'none',
    findingsDetail: [],
    events: [],
    phases: { routeMs: 0, resolveMs: 0, promptMs: 0, toBoundaryMs: 0 },
    timing: 'pre-inference',
    durationMs: 0
  }
  const live = options.live
  const settings = live?.settings ?? captureSettings(context)
  if (live) {
    result.sourceMode = 'live'
    result.timing = 'end-to-end'
    result.intentReplySource = 'live'
    result.inference = { model: live.model, calls: 0, firstTokenMs: null, outputChars: 0 }
  }
  const requestId = randomUUID()
  const input = {
    requestId,
    workspacePath: workspace,
    settings,
    text: question,
    model: live?.model ?? SIMULATED_MODEL_REF,
    mode,
    history: options.question?.history ?? [],
    threadId: options.question?.history?.length ? `eris-dev-${requestId}` : null,
    skillIds: [],
    getSecret: live?.getSecret ?? (() => null),
    signal: controller.signal,
    ...(live ? { resolverTimeoutMs: Math.min(options.timeoutMs ?? 180000, 120000) } : {}),
    // Timeout captures need the resolver's deadline to fire, not to wait 10 s per question.
    ...(!live && intentReplyMode === 'timeout' ? { resolverTimeoutMs: 250 } : {})
  }
  let fallback = 'answer'
  let captured = false
  let incomplete = false
  // Ledger events arrive before the request they describe; attach them to it.
  let pendingContext: unknown
  let pendingToolManifest: unknown
  const adapter: ModelAdapter = {
    kind: live ? 'live' : 'scripted',
    async *stream(request) {
      if (live && result.requests.length >= (options.maxCalls ?? 12)) {
        cause ??= 'call-limit'
        result.inference!.error = 'Question reached its model-call limit.'
        throw new Error(result.inference!.error)
      }
      if (live) request = { ...request, settings, model: live.model, getSecret: live.getSecret }
      const call: DevCapture = {
        purpose: request.purpose,
        model: request.model,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools ?? []),
        temperature: request.temperature,
        toolChoice: request.toolChoice,
        schema: request.builtinJsonSchema,
        ...(request.purpose === 'agent' && pendingContext ? { context: pendingContext } : {}),
        ...(request.purpose === 'agent' && pendingToolManifest
          ? { toolManifest: pendingToolManifest }
          : {})
      }
      result.requests.push(call)
      if (live) {
        if (request.purpose === 'agent') captured = true
        result.inference!.calls++
        const callStarted = Date.now()
        call.response = ''
        try {
          for await (const chunk of streamProviderChat({
            ...request,
            onTermination: (termination) => {
              call.termination = termination
              request.onTermination?.(termination)
            }
          })) {
            call.response += chunk
            lastProgressAt = Date.now() - started
            if (request.purpose === 'agent' && result.inference!.firstTokenMs === null)
              result.inference!.firstTokenMs = Date.now() - started
            result.inference!.outputChars += chunk.length
            if (result.inference!.outputChars > 250000) {
              stop('output-limit')
              throw new Error('Question exceeded its output character limit.')
            }
            yield chunk
          }
        } catch (error) {
          result.inference!.error = error instanceof Error ? error.message : String(error)
          call.error = result.inference!.error
          if (!controller.signal.aborted)
            cause ??= isWorkerFailure(error) ? 'worker-exited' : 'provider-error'
          throw error
        } finally {
          call.durationMs = Date.now() - callStarted
        }
        return
      }
      if (request.purpose === 'intent') {
        if (scriptedIntent) {
          result.intentReplySource = 'question-script'
          yield JSON.stringify(scriptedIntent)
          return
        }
        result.intentReplySource = intentReplyMode
        if (intentReplyMode === 'malformed') {
          yield 'not json'
          return
        }
        if (intentReplyMode === 'timeout') {
          // Never reply; the resolver's own deadline decides.
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            else request.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('Intent reply withheld for timeout capture.')
        }
        yield JSON.stringify({ intent: fallback, confidence: 0 })
        return
      }
      captured = true
      controller.abort()
      // Stop before any model response can propose or execute a tool call.
    }
  }
  try {
    await runInDiagnosticsScope(
      {
        runId: requestId,
        mode: live ? 'real-model' : 'simulated',
        adapter,
        onBlockedEffect: (kind, detail) => result.events.push(`Blocked ${kind}: ${detail}`),
        onTaskEvent: (event) => {
          if (event.type === 'context-compiled') pendingContext = event.data
          else if (event.type === 'tool-manifest') pendingToolManifest = event.data
          else if (event.type === 'route-decision') result.routeDecision = event.data
          else if (event.type === 'retrieval') result.retrieval = event.data
          else if (event.type === 'workflow-lint') result.workflowLint = event.data
        }
      },
      async () => {
        let phaseStarted = Date.now()
        const initial = await planInitialChatTurn(input)
        result.phases.routeMs = Date.now() - phaseStarted
        fallback = initial.intent
        if (initial.error) {
          result.detail = initial.error
          return
        }
        phaseStarted = Date.now()
        const { plan, task, resolution } = await resolveChatTurnContract(input, initial)
        result.phases.resolveMs = Date.now() - phaseStarted
        result.events.push(
          live
            ? `Intent resolver · ${resolution.source}:${resolution.rule} · live model ${live.model}`
            : describeResolution(resolution)
        )
        if (live) {
          plan.models = { chat: live.model, tools: live.model, router: live.model }
          plan.cloudPreferred = false
          plan.error = undefined
        }
        result.task = task
        result.agent = plan.agentName
        result.intent = plan.intent
        result.artifact = interpretationOf(task).artifact
        phaseStarted = Date.now()
        const messages = buildChatTurnMessages(
          workspace,
          settings,
          {
            text: question,
            mode,
            agentId: plan.agentId,
            attachments: [],
            history: options.question?.history ?? [],
            skillIds: []
          },
          plan
        )
        result.phases.promptMs = Date.now() - phaseStarted
        phaseStarted = Date.now()
        for await (const event of runAgentWithWorkspaceTools({
          workspacePath: workspace,
          settings,
          model: plan.models.chat,
          messages,
          temperature: settings.models.temperature,
          signal: controller.signal,
          getSecret: live?.getSecret ?? (() => null),
          mode,
          turnPlan: plan,
          mcp: 'off',
          allowDelegate: false,
          approveCommand: async () => false,
          approveMcpTool: async () => false
        })) {
          if (event.type === 'progress' && event.incomplete) incomplete = true
          if (event.type === 'answer') {
            // Answer events are deltas unless they explicitly replace the answer so far.
            const answer =
              event.replace || result.response === null ? event.text : result.response + event.text
            result.detail = answer
            if (live) result.response = answer
          }
          if (event.type === 'status' && result.events.length < 50) result.events.push(event.text)
          if ((!live && captured) || controller.signal.aborted) break
        }
        result.phases.toBoundaryMs = Date.now() - phaseStarted
      }
    )
    result.status = signal.aborted
      ? 'cancelled'
      : controller.signal.aborted
        ? 'error'
        : captured
          ? 'captured'
          : 'blocked'
    if (live) {
      result.completion = {
        status: signal.aborted
          ? 'cancelled'
          : incomplete
            ? 'incomplete'
            : result.status === 'captured' && result.response && !result.inference!.error
              ? 'completed'
              : 'failed',
        ...(incomplete
          ? { reason: result.detail || 'Agent stopped before completing the task.' }
          : {})
      }
      result.stages.inference = signal.aborted
        ? 'cancelled'
        : result.status === 'captured' && result.response && !result.inference!.error
          ? 'completed'
          : 'error'
      result.responseReason =
        result.stages.inference === 'completed' ? 'generated' : 'inference-failed'
      if (result.stages.inference === 'error')
        result.inference!.error ??= result.detail || 'No final answer was produced.'
    }
  } catch (error) {
    // The streamed answer so far stays partial output; the last raw agent draft is
    // separate evidence, never promoted to a final answer.
    if (live) {
      const draft = [...result.requests]
        .reverse()
        .find((r) => r.purpose === 'agent' && r.response)?.response
      if (draft && draft !== result.response) result.draft = draft
    }
    if (live && !controller.signal.aborted)
      cause ??= isWorkerFailure(error) ? 'worker-exited' : 'provider-error'
    result.status = !live && captured ? 'captured' : signal.aborted ? 'cancelled' : 'error'
    if (live || !captured) result.detail = error instanceof Error ? error.message : String(error)
    if (live) {
      result.completion = { status: signal.aborted ? 'cancelled' : 'failed', reason: result.detail }
      result.stages.inference = signal.aborted ? 'cancelled' : 'error'
      result.responseReason = 'inference-failed'
      result.inference!.error = result.detail
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
    await flushTaskLedger(requestId)
  }
  // Set from abort and stream callbacks, which control-flow narrowing cannot see.
  const firstCause = cause as DevTerminationCause | null
  if (!live && captured)
    result.detail = 'Stopped at the model transport boundary. No agent response was generated.'
  else if (firstCause === 'deadline-exceeded')
    result.detail = live
      ? 'Live question exceeded its configured deadline.'
      : 'Capture exceeded the 30 second deadline.'
  if (live) {
    result.termination = {
      cause:
        firstCause ??
        (result.completion?.status === 'incomplete'
          ? 'agent-incomplete'
          : result.completion?.status === 'completed'
            ? 'completed'
            : 'no-answer'),
      elapsedMs: Date.now() - started,
      lastProgressAt
    }
    if (firstCause === 'deadline-exceeded' && result.inference) {
      result.inference.error = 'Live question exceeded its configured deadline.'
      if (result.completion) result.completion.reason = result.inference.error
    }
    // Runtime completion is not deliverable validity: a completed transport can
    // still return protocol framing, truncated code or a refusal.
    if (result.response !== null || result.completion?.status === 'completed')
      result.deliverable = assessDeliverable(result.response, {
        ...deliverableContext(question, result.artifact),
        termination: firstCause ?? undefined
      })
  }
  if (result.task) {
    result.findingsDetail = requestInvariantFindings({
      task: result.task as TaskContract,
      requests: result.requests,
      imagesEnabled: settings.images.enabled,
      mcpToolCount: 0
    })
    result.findings = {
      defect: result.findingsDetail.filter((finding) => finding.severity === 'defect').length,
      review: result.findingsDetail.filter((finding) => finding.severity === 'review').length
    }
    result.findingIds = result.findingsDetail.map((finding) => finding.id)
    result.stages.requestValidity = result.findings.defect
      ? 'defects'
      : result.findings.review
        ? 'review'
        : 'no-findings'
  }
  result.stages.reachability = result.status
  result.calls = result.requests.length
  result.durationMs = Date.now() - started
  return result
}
