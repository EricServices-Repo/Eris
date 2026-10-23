import { randomUUID } from 'crypto'
import type { DevCapture, DevQuestion, DevResult, IntentReplyMode } from '../../src/shared/eris-dev'
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
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const timeout = setTimeout(cancel, 30000)
  const intentReplyMode = options.intentReplyMode ?? 'fallback'
  const scriptedIntent = options.question?.intentReply
  const result: DevResult = {
    index,
    questionId: options.question?.id ?? `run-${index}`,
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
  const settings = captureSettings(context)
  const requestId = randomUUID()
  const input = {
    requestId,
    workspacePath: workspace,
    settings,
    text: question,
    model: SIMULATED_MODEL_REF,
    mode,
    history: options.question?.history ?? [],
    threadId: options.question?.history?.length ? `eris-dev-${requestId}` : null,
    skillIds: [],
    getSecret: () => null,
    signal: controller.signal,
    // Timeout captures need the resolver's deadline to fire, not to wait 10 s per question.
    ...(intentReplyMode === 'timeout' ? { resolverTimeoutMs: 250 } : {})
  }
  let fallback = 'answer'
  let captured = false
  // Ledger events arrive before the request they describe; attach them to it.
  let pendingContext: unknown
  let pendingToolManifest: unknown
  const adapter: ModelAdapter = {
    kind: 'scripted',
    async *stream(request) {
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
        mode: 'simulated',
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
        result.events.push(describeResolution(resolution))
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
          getSecret: () => null,
          mode,
          turnPlan: plan,
          mcp: 'off',
          allowDelegate: false,
          approveCommand: async () => false,
          approveMcpTool: async () => false
        })) {
          if (event.type === 'answer') result.detail = event.text
          if (event.type === 'status' && result.events.length < 50) result.events.push(event.text)
          if (captured || controller.signal.aborted) break
        }
        result.phases.toBoundaryMs = Date.now() - phaseStarted
      }
    )
    result.status = captured ? 'captured' : signal.aborted ? 'cancelled' : 'blocked'
  } catch (error) {
    result.status = captured ? 'captured' : signal.aborted ? 'cancelled' : 'error'
    if (!captured) result.detail = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
    await flushTaskLedger(requestId)
  }
  if (captured)
    result.detail = 'Stopped at the model transport boundary. No agent response was generated.'
  else if (controller.signal.aborted && !signal.aborted)
    result.detail = 'Capture exceeded the 30 second deadline.'
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
