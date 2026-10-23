import { randomUUID } from 'crypto'
import type { DevCapture, DevResult } from '../../src/shared/eris-dev'
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

export async function captureQuestion(
  index: number,
  question: string,
  workspace: string,
  context: number,
  mode: 'ask' | 'agent',
  signal: AbortSignal
): Promise<DevResult> {
  const started = Date.now()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const timeout = setTimeout(cancel, 30000)
  const result: DevResult = {
    index,
    question,
    status: 'blocked',
    calls: 0,
    requests: [],
    events: [],
    durationMs: 0
  }
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
  const requestId = randomUUID()
  const input = {
    requestId,
    workspacePath: workspace,
    settings,
    text: question,
    model: SIMULATED_MODEL_REF,
    mode,
    history: [],
    threadId: null,
    skillIds: [],
    getSecret: () => null,
    signal: controller.signal
  }
  let fallback = 'answer'
  let captured = false
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
        schema: request.builtinJsonSchema
      }
      result.requests.push(call)
      if (request.purpose === 'intent') {
        result.events.push(
          'Intent model response simulated: retain deterministic routing with confidence 0.'
        )
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
        onBlockedEffect: (kind, detail) => result.events.push(`Blocked ${kind}: ${detail}`)
      },
      async () => {
        const initial = await planInitialChatTurn(input)
        fallback = initial.intent
        if (initial.error) {
          result.detail = initial.error
          return
        }
        const { plan, task } = await resolveChatTurnContract(input, initial)
        result.task = task
        result.agent = plan.agentName
        result.intent = plan.intent
        const messages = buildChatTurnMessages(
          workspace,
          settings,
          {
            text: question,
            mode,
            agentId: plan.agentId,
            attachments: [],
            history: [],
            skillIds: []
          },
          plan
        )
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
  result.calls = result.requests.length
  result.durationMs = Date.now() - started
  return result
}
