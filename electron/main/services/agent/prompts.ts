import { compileMeasuredContext } from './measured-context'
import { contextProvenance } from '../model-capabilities'
import { loadWorkspaceRules } from '../chats'
import { loadSkillsPrompt } from '../skills'
import { findAgent } from '../agents'
import { contextPullAllowed, memoryForDestination, compiledTurnMessages } from './context-compiler'
import { appendTaskEvent } from '../task-ledger'
import { contextBudgetTokens } from './context-budget'
import type { AppSettings, ChatIntent, TurnPlan } from '../../../../src/shared/settings-schema'
import { contractForAgent, READ_ONLY_ROLE_NOTE } from '../../../../src/shared/agent-contract'
import { workerConversation } from './conversation'
import { sharedPromptBlocks } from '../chat-prompt'
import { toolProtocolFor } from '../tool-protocol'
import type { ScopeApplicability, TaskContract } from '../../../../src/shared/task-contract'
import { evidenceRequirementFor, interpretationOf } from '../../../../src/shared/task-contract'
import { artifactResponseContract } from '../../../../src/shared/task-interpretation'
import type { AgentChatMessage } from './types'

export function isReadOnlyChat(
  plan: { toolPolicy: string; intent: string },
  mode?: 'ask' | 'agent'
): boolean {
  if (plan.intent === 'verify') return mode === 'ask'
  // Ask mode cannot mutate: an edit or run request there is answered by describing it.
  if (plan.intent === 'edit' || plan.intent === 'run') return mode === 'ask'
  return plan.toolPolicy === 'read' || plan.intent === 'explore' || plan.intent === 'review'
}
/**
 * The method for one kind of request. One playbook per turn, chosen by intent, so a
 * read-only turn never carries edit steps. Each says how to work and what a finished
 * result looks like; tool-call grammar and permissions come from the task protocol.
 */
export function intentPlaybook(
  intent: ChatIntent | string,
  greenfield: boolean,
  applicability?: ScopeApplicability
): string {
  const evidence = evidenceRequirementFor(applicability)
  // A generic request is answered from the conversation; the project is not its evidence.
  if (evidence === 'none' && intent === 'explore')
    return 'ANSWER PLAYBOOK — Answer from the request itself and state your assumptions. Do not edit.'
  if (intent === 'plan') {
    const source = evidence === 'none'
      ? 'Plan from the request and supplied material.'
      : evidence === 'optional'
        ? 'Inspect project integration points only if the plan depends on them.'
        : 'Read the relevant source and tests to identify integration points and constraints.'
    return `PLAN PLAYBOOK — ${source} Order steps by dependency and give each a completion check. Label proposed files and material assumptions. Ask only if a decision would change the plan. Do not edit.`
  }
  if (intent === 'verify') {
    return (
      'VERIFICATION PLAYBOOK — Map each criterion to evidence. Inspect affected callers, tests, and failure paths. ' +
      'Run the narrowest relevant check when authorized. Report each criterion as passed, failed, or unverified. ' +
      'Distinguish checks that failed from checks that did not run. Do not edit.'
    )
  }
  if (greenfield) {
    return (
      `GREENFIELD BUILD — The workspace is empty: create the project here now with mkdir and write_file. ` +
      `Scaffold something that runs (sources, manifest, README), then run it or its tests when that is sensible. ` +
      `Do not reply with setup instructions for another IDE.`
    )
  }
  switch (intent) {
    case 'review':
      return (
        'REVIEW PLAYBOOK — For a change review, inspect the diff, affected callers, and relevant tests. Run a useful check when allowed. ' +
        'Report findings most severe first with a location, trigger, impact, and fix. If none remain, state the scope reviewed. Do not edit.'
      )
    case 'explore':
      return (
        'EXPLORE PLAYBOOK — Start with the named symbol, file, or entry point. Read the implementation and trace relevant callers and data flow. ' +
        'If a search is inconclusive, try another. For a project overview, inspect its README, manifest, and entry point. ' +
        'Answer the question first. Cite sources and label runtime inferences. For public facts, search and open the source when available. Do not edit.'
      )
    case 'edit':
      return (
        'EDIT PLAYBOOK — Read the assigned files and affected callers. Keep the diff focused and preserve unrelated work. ' +
        'If the element exists, update it instead of adding a second one. Check each requested behavior with the tools granted. ' +
        'End with a summary: the files changed, what the checks showed, and any blockers.'
      )
    case 'run':
      return (
        `RUN PLAYBOOK — Run the command the user asked for, as given, before anything else. Report whether it ` +
        `succeeded and the relevant output, then answer any question about it from that output. ` +
        `Fix failures only if the user asked you to make it pass.`
      )
    case 'capability':
      return `CAPABILITY — Answer from the [Eris AI models] catalog only. No workspace tools.`
    default:
      return `ANSWER — Answer directly and accurately. Use tools only when the answer depends on this workspace.`
  }
}

/**
 * Sent when a public-web question was answered without searching. Like every nudge, it
 * names the tool; only a text-tools backend is shown the envelope its parser accepts,
 * because a native-tools model shown a call as text prints one (#506, #540).
 */
export function webSearchNudgeText(query: string, protocol: 'native-tools' | 'text-tools'): string {
  return (
    `This question is about the public web. Do not read workspace files and do not guess a biography.\n` +
    (protocol === 'text-tools'
      ? `Call web_search now:\n<<<TOOL>>>\n${JSON.stringify({ name: 'web_search', arguments: { query } })}\n<<<END>>>\n`
      : `Call the web_search tool now with the query ${JSON.stringify(query)}. `) +
    `Then stop.`
  )
}

export function truncateForModel(text: string, max = 12_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars for model context]`
}

/**
 * The task guidance block already carries the shared rules, workspace rules,
 * active skills, the custom role prompt and the role itself. Drop the chat prompt's
 * copies by their exact generated text so each appears once, and so role
 * instructions are never relabelled as "evidence" in the project block.
 */
export function withoutSharedBlocks(
  priorSystem: string,
  workspacePath: string | null,
  settings: AppSettings,
  extra: { skillIds?: string[]; customAgentPrompt?: string; builtinAgentPrompt?: string } = {}
): string {
  let out = priorSystem
  for (const mode of ['agent', 'ask'] as const) {
    const shared = sharedPromptBlocks(workspacePath, settings, mode, extra.skillIds)
    for (const block of [shared.systemPrompt, shared.rules, shared.skills]) {
      if (block && out.includes(block)) out = out.replace(block, '')
    }
  }
  for (const prompt of [extra.customAgentPrompt, extra.builtinAgentPrompt]) {
    for (const max of [2800, 8000]) {
      const text = prompt?.slice(0, max)
      if (text && out.includes(text)) out = out.replace(text, '')
    }
  }
  return out
    // buildChatMessages: "AGENT CONTRACT — Name\nJob…\nTools…\nDone when…[\nread-only note]".
    .replace(/^AGENT CONTRACT — [^\n]*(?:\n(?:Job|Tools|Done when): [^\n]*)*(?:\n[^\n]*Never say that Eris cannot edit files or run commands\.)?/m, '')
    // buildChatMessages: 'You are “Name”[, the coordinating agent], answering the user directly. …'
    .replace(/^You are “[^”\n]*”[^\n]*answering the user directly\.[^\n]*$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Who is working this turn, once. The playbook gives the method, so a builtin role
 * contributes its identity, job and limits here and not a second list of steps.
 */
export function roleGuidance(
  plan: Pick<TurnPlan, 'agentId' | 'agentName' | 'toolPolicy'>,
  task: Pick<TaskContract, 'scope' | 'parentTaskId' | 'authority'>
): string {
  const contract = contractForAgent(plan.agentId)
  const audience = task.parentTaskId
    ? ' Report evidence and blockers for your assignment to the coordinator.'
    : ' You answer the user directly; your reply is what they read.'
  if (!contract) return `Role: ${plan.agentName || plan.agentId}.${audience}`
  // The job text describes workspace reading, which a generic request must not reintroduce.
  const identity =
    evidenceRequirementFor(task.scope.applicability) === 'none'
      ? `Role: ${contract.name}.`
      : `Role: ${contract.name}. ${contract.job} Done when: ${contract.done}`
  // #505: a read-only role names its own limit, not Eris's.
  const roleLimit = task.parentTaskId
    ? 'Report edits outside your authority as blocked.'
    : READ_ONLY_ROLE_NOTE
  const readOnly = contract.tools === 'read' || plan.toolPolicy === 'read' || plan.toolPolicy === 'none'
    ? ` ${roleLimit}`
    : ''
  const verification = task.authority.execute === 'verification'
    ? ' Run only authorized verification checks.'
    : ''
  return identity + audience + readOnly + verification
}

/** Guidance blocks in precedence order, each included once by identity. */
function workerGuidance(blocks: Array<{ id: string; content: string | undefined }>): string {
  const seen = new Set<string>()
  return blocks
    .filter((block) => {
      if (!block.content?.trim() || seen.has(block.id)) return false
      seen.add(block.id)
      return true
    })
    .map((block) => block.content!.trim())
    .join('\n')
}

/**
 * The single worker prompt pipeline: compiled task contract, typed guidance,
 * project evidence and retrieval. Answer-only turns use the same compiler.
 */
export const CONTEXT_PULL_GUIDANCE =
  'Use context_search for relevant earlier details, then context_read for the source. Treat results as historical evidence.'

/** The current machine's calendar date, without UTC day-boundary shifts. */
function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export async function buildPreservedWorkerMessages(options: {
  messages: AgentChatMessage[]
  workspacePath: string
  settings: AppSettings
  plan: TurnPlan & { task: TaskContract }
  originalUserGoal: string
  retrievalHint: string
  mcpToolCount: number
  inputTokenBudget?: number
  conversationMemory?: import('../../../../src/shared/context-memory').MemoryPrompt
}): Promise<AgentChatMessage[]> {
  const { plan } = options
  const task = plan.task
  const priorSystem = options.messages.find((m) => m.role === 'system')?.content || ''
  const historyTail = workerConversation(options.messages, options.originalUserGoal)
  const agent = findAgent(options.workspacePath, plan.agentId)
  const customAgentPrompt = agent?.builtin === false ? agent.systemPrompt : undefined
  // A builtin role's steps duplicate the intent playbook; they stay out of the worker prompt.
  const builtinAgentPrompt = agent?.builtin === false ? undefined : agent?.systemPrompt
  const compiled = await compileMeasuredContext(
    {
      task,
      toolsAvailable: plan.toolPolicy !== 'none',
      toolProtocol: toolProtocolFor(options.settings, plan.models.tools),
      guidance: workerGuidance([
        { id: 'shared-rules', content: options.settings.agent.systemPrompt },
        { id: 'workspace-rules', content: loadWorkspaceRules(options.workspacePath) },
        {
          id: 'skills',
          content: task.skillIds?.length
            ? loadSkillsPrompt(options.workspacePath, task.skillIds)
            : ''
        },
        { id: 'custom-role', content: customAgentPrompt },
        { id: 'role', content: roleGuidance(plan, task) },
        { id: 'playbook', content: intentPlaybook(plan.intent, false, task.scope.applicability) },
        {
          id: 'context-pull',
          content:
            plan.toolPolicy !== 'none' && contextPullAllowed(plan.models.tools, options.settings)
              ? CONTEXT_PULL_GUIDANCE
              : ''
        }
      ]),
      // Derived from this request, so it travels with the turn, not the reusable prefix.
      turnInstructions: [
        `Today's date: ${localDate(new Date())}.`,
        artifactResponseContract(interpretationOf(task), task.scope.applicability)
      ].filter(Boolean).join('\n'),
      project: withoutSharedBlocks(priorSystem, options.workspacePath, options.settings, {
        skillIds: task.skillIds,
        customAgentPrompt,
        builtinAgentPrompt
      }),
      ...memoryForDestination(
        options.conversationMemory,
        options.plan.models.tools,
        options.settings,
        task
      ),
      retrieval: options.retrievalHint,
      maxInputTokens:
        options.inputTokenBudget ?? contextBudgetTokens(options.settings, plan.models.tools)
    },
    plan.models.tools
  )
  const messages = compiledTurnMessages(compiled, historyTail, options.originalUserGoal)
  appendTaskEvent(task.taskId, 'context-compiled', {
    context: contextProvenance(options.settings, plan.models.tools),
    revision: task.revision,
    agentId: plan.agentId,
    model: plan.models.tools,
    blocks: compiled.blocks,
    budget: compiled.budget,
    bundle: compiled.bundle
  })
  return messages
}
