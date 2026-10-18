import type { ChatIntent } from './settings-schema'

/**
 * The chat roster. Auto assigns one of these from the message.
 * Coder is not chosen by Auto — pin it, or let Composer delegate to it.
 */
export interface ChatAgentContract {
  id: 'composer' | 'coder' | 'explainer' | 'planner' | 'reviewer' | 'verifier' | 'fast'
  name: string
  /** One sentence the picker and the model both follow. */
  job: string
  tools: 'read' | 'edit' | 'full'
  /** True when Auto may select this agent. */
  auto: boolean
  doesNot: string
  done: string
}

export const CHAT_AGENT_CONTRACTS: ChatAgentContract[] = [
  {
    id: 'composer',
    name: 'Composer',
    job: 'Owns changes: inspect the workspace, edit it, verify, and delegate only when the work splits.',
    tools: 'full',
    auto: true,
    doesNot: 'Does not ask the user to paste files that are already in the workspace, and does not hand off a small single-file fix.',
    done: 'A short summary of files changed or what was found. Delegated work is included only after those agents finish.'
  },
  {
    id: 'coder',
    name: 'Coder',
    job: 'Implements one assigned change with a small diff. Used when pinned, or when Composer delegates.',
    tools: 'edit',
    auto: false,
    doesNot: 'Does not widen the task, open pull requests, or delegate further.',
    done: 'The assigned files are edited and, when the project has them, tests or typecheck have been run.'
  },
  {
    id: 'explainer',
    name: 'Explainer',
    job: 'Reads the workspace and explains how it actually behaves.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit files. In Ask mode it may read relevant workspace sources but cannot mutate or run commands.',
    done: 'A short explanation with the real file paths and symbols it read.'
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    job: 'Reads the change or the project and reports bugs, risks, and missing tests.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit. May run project tests, typecheck, or lint. If the user wants fixes, it says to run Composer.',
    done: 'Findings with a path, what is wrong, why it matters, and a suggested fix. Ordered blockers, risks, suggestions, nits.'
  },
  {
    id: 'planner',
    name: 'Plan',
    job: 'Reads the workspace and produces an implementation plan with dependencies, risks, and files to change.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit files or claim the plan has been implemented.',
    done: 'A sequenced plan with the relevant files, key decisions, dependencies, and completion checks.'
  },
  {
    id: 'verifier',
    name: 'Verification',
    job: 'Adversarially checks a change by inspecting its code and running relevant tests or typechecks.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit files or report a check as passing without observing its result.',
    done: 'A concise verdict backed by the checks run, their actual results, and any uncovered edge cases.'
  },
  {
    id: 'fast',
    name: 'Fast',
    job: 'Answers a short lookup in a few sentences, reading the workspace when the answer depends on it.',
    tools: 'read',
    auto: true,
    doesNot: 'Does not edit, plan, or write a long tour of the codebase.',
    done: 'One to three sentences with the path or symbol, or a single line saying Composer should take an edit.'
  }
]

/** “What does this project do?” — a description, not a defect review. */
export function asksWhatTheProjectDoes(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    /\bwhat does (it|this) do\b/i.test(t) ||
    /\bwhat (does|is) (this|the) (project|app|application|repo|codebase|workspace)\b/i.test(t) ||
    /\b(describe|tell me about) (this |the )?(project|app|application|repo|codebase|workspace)\b/i.test(
      t
    )
  )
}

/** The user is asking to apply previously discussed changes, not list them. */
export function asksToImplementChanges(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    /\b(?:code|implement|apply|write|build|make|add)\b[\s\S]{0,48}\b(?:these|those|the|above|recommended|suggested)?\s*(?:changes?|improvements?|fixes?)\b/i.test(
      t
    ) ||
    /\b(?:code|implement|apply|write|build|make|add)\s+(?:it|that|those|them|these)\b/i.test(t)
  )
}

/** An explicit request for a plan, rather than a request to execute the plan. */
export function asksForPlan(text: string): boolean {
  const t = text.trim()
  if (!t || asksToImplementChanges(t)) return false
  if (/\b(?:and|then)\s+(?:implement|code|build|create|write|add|change|update|fix|apply)\b/i.test(t)) {
    return false
  }
  return (
    /\b(?:give|write|create|draft|outline|propose|make|show)\s+(?:me\s+)?(?:an?\s+)?(?:(?:implementation|technical|architecture|migration)\s+)?plan\b/i.test(
      t
    ) ||
    /\bplan\s+(?:out\s+)?(?:how|to|for)\b/i.test(t) ||
    /\bplan\b[\s\S]{0,32}\b(?:changes?|improvements?|features?|work|implementation|architecture|migration)\b/i.test(
      t
    ) ||
    /\bwhat(?:'s| is)\s+(?:the|your|a)\s+plan\b/i.test(t)
  )
}

/** The user wants the implementation tested or validated, not merely reviewed. */
export function asksForVerification(text: string): boolean {
  const t = text.trim()
  if (!t || asksToImplementChanges(t)) return false
  if (
    /\b(?:fix|change|edit|implement|update|apply|repair)\b[\s\S]{0,32}\b(?:code|file|bug|feature|issue|failure|error|changes?|it|this|that)\b/i.test(
      t
    )
  ) {
    return false
  }
  // Keep direct command requests on the ordinary Run route.
  if (
    /\b(?:run|execute)\b[\s\S]{0,32}\b(?:tests?|typechecks?|lint|build)\b/i.test(t) ||
    /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|check))\b/i.test(t)
  ) {
    return false
  }
  return (
    /\b(?:verify|validate|test)\b[\s\S]{0,56}\b(?:changes?|implementation|code|fix|feature|project|behavior|edge cases?|regressions?|this|that|these|those|it)\b/i.test(
      t
    ) ||
    /\b(?:check|confirm|test|verify|validate)\b[\s\S]{0,40}\b(?:the\s+|these\s+|those\s+|my\s+|our\s+)?(?:code|changes?|implementation|tests?|fix|feature|behavior)\b/i.test(
      t
    ) ||
    /\b(?:check|confirm)\b[\s\S]{0,32}\b(?:that|whether|if)\b[\s\S]{0,48}\b(?:works?|passes?|correct|safe|behaves?|regresses?)\b/i.test(
      t
    ) ||
    /\b(?:try to break|look for edge cases|test the behavior)\b/i.test(t) ||
    /^(?:verify|validate|test)(?:\s+(?:it|that))?[.!?]?$/i.test(t)
  )
}

/** The user wants a list of improvements, not for the agent to apply them. */
export function asksForRecommendations(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (asksToImplementChanges(t)) return false
  if (
    /\b(make|apply|implement)\s+(the\s+|some\s+|these\s+)?improvements?\b/i.test(t) &&
    !/\bwhat\b/i.test(t)
  ) {
    return false
  }
  return (
    /\bwhat\b[\s\S]{0,48}\bimprov/i.test(t) ||
    /\b(list|suggest|recommend)\b[\s\S]{0,40}\b(improv|changes?|ideas)\b/i.test(t) ||
    (/\breview\b/i.test(t) && /\bwhat\b[\s\S]{0,48}\b(improv|should we)\b/i.test(t))
  )
}

/** A public-web question. The workspace cannot answer it. */
export function needsWebLookup(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    /\b(internet|on the web|online|search (?:the )?web|look up online|look up on the web)\b/i.test(t) ||
    /\b(latest|current|recent|today|yesterday|this week|this month|as of now)\b[\s\S]{0,60}\b(news|price|prices|release|version|weather|schedule|policy|law|regulation|market|score|availability|status)\b/i.test(t) ||
    /\bwho (is|was|are)\b/i.test(t)
  )
}

/** Questions whose answer should be grounded in the open workspace. */
export function asksWorkspaceQuestion(text: string, fileNames: string[] = []): boolean {
  const t = text.trim()
  if (!t) return false
  if (
    /\b(this|that|the|my|our)\s+(project|repo|repository|workspace|codebase|app|application|folder|file|code|component|function|service|api)\b/i.test(t) ||
    /\b(where is|which file|what file|find (?:the )?(?:file|function|class|component)|in the (?:repo|project|workspace))\b/i.test(t) ||
    /\b(function|class|method|component|hook|module|service|route|endpoint|config|stack trace|test failure|build error|source code|bug|exception|crash(?:es|ed|ing)?|fail(?:s|ed|ing)?|broken|not working|doesn't work|typescript|javascript|python|compile|compiler|import error)\b/i.test(t)
  ) {
    return true
  }
  return fileNames.some((name) => name.trim() && t.toLowerCase().includes(name.toLowerCase()))
}

const BY_ID = new Map(CHAT_AGENT_CONTRACTS.map((c) => [c.id, c]))

/** A short reply that depends on the previous turn, not a new task. */
export function isConversationFollowUp(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 240 || asksWhatTheProjectDoes(t)) return false
  if (asksToImplementChanges(t)) return true
  if (
    /^(and|also|then|continue|go on|keep going|do that|fix that|change that|update that|what about|how about)\b/i.test(
      t
    )
  ) {
    return true
  }
  if (/\bwhat did you (change|do|edit)\b/i.test(t)) return true
  return t.length < 100 && /\b(that|those|them)\b/i.test(t)
}

/**
 * Who should take a follow-up. "Fix that" moves to Composer.
 * "What did you change?" moves to Explainer. Otherwise stay with the previous agent.
 */
export function agentForFollowUp(
  text: string,
  previousAgentId: string | null | undefined
): ChatAgentContract['id'] | null {
  if (!isConversationFollowUp(text)) return null
  if (/\bwhat did you (change|do|edit)\b/i.test(text)) return 'explainer'
  if (
    asksToImplementChanges(text) ||
    /\b(fix|change|edit|implement|update|apply)\b/i.test(text)
  ) {
    return 'composer'
  }
  if (previousAgentId && BY_ID.has(previousAgentId as ChatAgentContract['id'])) {
    const id = previousAgentId as ChatAgentContract['id']
    return id === 'coder' ? 'composer' : id
  }
  return null
}

export function contractForAgent(id: string | null | undefined): ChatAgentContract | null {
  if (!id) return null
  return BY_ID.get(id as ChatAgentContract['id']) ?? null
}

/**
 * Which builtin agent speaks for this chat turn.
 * Edit and run stay with Composer. Coder is never returned.
 */
export function chatAgentForTurn(options: {
  mode: 'ask' | 'agent'
  intent: ChatIntent
  text: string
  previousAgentId?: string | null
}): ChatAgentContract['id'] {
  const text = options.text.trim()
  const explains = /\b(explain|how|why|overview|summarize|architecture)\b/i.test(text)
  const shortLookup =
    text.length > 0 &&
    text.length < 80 &&
    /\b(where is|which file|what file)\b/i.test(text) &&
    !explains

  if (options.mode === 'ask') {
    if (options.intent === 'plan') return 'planner'
    if (options.intent === 'verify') return 'verifier'
    return shortLookup ? 'fast' : 'explainer'
  }

  if (options.intent === 'plan') return 'planner'
  if (options.intent === 'verify') return 'verifier'
  const follow = agentForFollowUp(text, options.previousAgentId)
  if (follow) return follow
  if (needsWebLookup(text)) return 'explainer'
  if (asksWhatTheProjectDoes(text)) return 'explainer'
  if (options.intent === 'review') return 'reviewer'
  if (options.intent === 'edit' || options.intent === 'run') return 'composer'
  if (options.intent === 'explore') return shortLookup ? 'fast' : 'explainer'
  if (explains) return 'explainer'
  if (text.length > 0 && text.length < 80) return 'fast'
  return 'explainer'
}
