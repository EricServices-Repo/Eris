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
    doesNot:
      'Does not ask the user to paste files that are already in the workspace, and does not hand off a small single-file fix.',
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
    doesNot:
      'Does not edit files. In Ask mode it may read relevant workspace sources but cannot mutate or run commands.',
    done: 'A short explanation with the real file paths and symbols it read.'
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    job: 'Reads the change or the project and reports bugs, risks, and missing tests.',
    tools: 'read',
    auto: true,
    doesNot:
      'Does not edit. May run project tests, typecheck, or lint. If the user wants fixes, it says to run Composer.',
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
  let t = text.trim()
  if (!t) return false
  if (
    /^(?:verify|validate|test|check|confirm)\b/i.test(t) &&
    !/\b(?:and|then)\s+(?:implement|apply|fix|update|change|edit|code|write)\b/i.test(t)
  ) {
    return false
  }
  // “How would you write it?” asks about an approach; it does not ask to apply one.
  t = t.replace(
    /\bhow\s+(?:would|should|could|do|can|might)\s+(?:you|i|we|one)\s+(?:go\s+about\s+)?(?:code|implement|apply|write|build|make|add)\s+(?:it|that|those|them|these)\b/gi,
    ' '
  )
  // Require the changes to be the verb's object. Proximity alone treats
  // 'Review the website build; recommend improvements' as permission to edit.
  return (
    /\b(?:code|implement|apply|write|build|make|add)\s+(?:(?:all|of|these|those|the|above|recommended|suggested|requested|following|needed|proposed|some|my|our|\d+)\s+)*(?:changes?|improvements?|fixes?)\b/i.test(
      t
    ) || /\b(?:code|implement|apply|write|build|make|add)\s+(?:it|that|those|them|these)\b/i.test(t)
  )
}

/** An explicit request for a plan, rather than a request to execute the plan. */
export function asksForPlan(text: string): boolean {
  const t = text.trim()
  if (!t || asksToImplementChanges(t)) return false
  if (
    /\b(?:and|then)\s+(?:implement|code|build|create|write|add|change|update|fix|apply)\b/i.test(t)
  ) {
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

/**
 * The request leads with producing something (code, an example, an implementation).
 * Later verification words then describe the artifact, not the controlling action.
 */
function leadsWithArtifactRequest(text: string): boolean {
  return (
    /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:write|implement|build|create|generate|draft|sketch|code|scaffold|design)\b/i.test(
      text
    ) ||
    /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:show|give)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:\w+\s+){0,3}?(?:example|sample|snippet|implementation|code|version|demo|how)\b/i.test(
      text
    ) ||
    /^(?:i\s+(?:need|want|would like)\s+to|help me(?:\s+to)?)\s+(?:implement|write|build|create|add|design)\b/i.test(
      text
    )
  )
}

/**
 * Remove verification words that describe a feature rather than request a check:
 * relative clauses (“health checks that verify dependencies”) and noun modifiers
 * (“seeding realistic test data”, “good test coverage”).
 */
function withoutFeatureVerificationNouns(text: string): string {
  return text
    .replace(
      /\b(?:that|which|who)\s+(?:verif(?:y|ies)|validates?|tests?|checks?|confirms?)\b[^.?!;]*/gi,
      ' '
    )
    .replace(
      /\btest\s+(?:data|coverage|fixtures?|doubles?|harness(?:es)?|accounts?|users?|environments?|records?|seeds?)\b/gi,
      ' '
    )
    .replace(/\bhealth\s+checks?\b/gi, ' ')
}

/**
 * A self-contained code artifact for chat: “show a TypeScript example”, “write a Java
 * version of …”. A named file or the open project as destination makes it a patch instead.
 */
export function asksForCodeExample(text: string): boolean {
  const t = text.trim()
  if (!t || asksToImplementChanges(t) || asksForPlan(t)) return false
  if (asksForCodeDestination(t)) return false
  // “Show me where the limiter is” locates existing code; it does not ask for new code.
  if (asksToLocateCode(t)) return false
  // “Explain why this example fails” and “review this example” make the example an operand.
  if (/^(?:please\s+)?(?:explain|review|debug|why|what(?:'s| is)\s+wrong)\b/i.test(t)) return false
  if (requestsExampleByForm(t) || writesBehavior(t)) return true
  const artifact =
    /\b(?:example|sample|snippet|demo|function|implementation|version|code|class|module|middleware|endpoint|script|component|logic|algorithm|handler|helper|hook|parser|query)\b/i
  const producing =
    /\b(?:write|generate|show|give|create|build|implement|draft|sketch|provide|turn)\b/i
  return producing.test(t) && artifact.test(t)
}

/** “Show me where X is”, “which file has X”: repository lookup, not generation. */
export function asksToLocateCode(text: string): boolean {
  return /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:show|tell)\s+(?:me\s+)?(?:where|which\s+(?:file|module|function|class)|what\s+file)\b|\bwhere\s+(?:is|are|do|does)\s+(?:the|our|my|this)\b|\b(?:which|what)\s+file\b/i.test(
    text
  )
}

/**
 * The request form alone names an example: “I need a practical example of X”,
 * “could I get a sample of Y”. No producing verb is needed.
 */
function requestsExampleByForm(text: string): boolean {
  return /^(?:please\s+)?(?:i\s+(?:need|want|would\s+like|'d\s+like)|i(?:'d| would)\s+(?:like|love)|(?:can|could|may)\s+i\s+(?:get|have|see)|(?:can|could|would)\s+you\s+(?:show|give|provide)\s+(?:me\s+)?|(?:show|give)\s+me|looking\s+for)\s+(?:(?:an?|some|the|one|two|both)\s+)?(?:[\w-]+\s+){0,3}?(?:examples?|samples?|snippets?|demos?|implementations?|versions?|code)\s+(?:of|for|showing|that|which|to|in)\b/i.test(
    text
  )
}

const PROSE_ARTIFACT =
  /^(?:an?\s+|the\s+|some\s+|me\s+)*(?:(?:short|brief|quick|detailed|clear|concise|good)\s+)?(?:summary|essay|blog|post|article|email|e-mail|letter|doc|docs|documentation|readme|description|paragraph|report|overview|comparison|explanation|story|poem|message|note|notes|changelog|commit\s+message|proposal|spec|specification|tutorial|guide|faq|cover\s+letter|bio|tweet|outline|review|list)\b/i

/**
 * “Can you write per-user rate limiting so errors are explicit?” asks for code even
 * without an artifact noun. “Write a summary of rate limiting” stays prose.
 */
function writesBehavior(text: string): boolean {
  const match = text.match(
    /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:write|code\s+up|implement)\s+(.+)$/i
  )
  if (!match) return false
  const object = match[1]!
  return (
    !PROSE_ARTIFACT.test(object) && !/^(?:about|on|up\s+(?:a|an|the)\s+summary)\b/i.test(object)
  )
}

/**
 * Schema, architecture or code-structure design: an answer with interfaces, state
 * ownership and tradeoffs. “How should I structure the code for X” is design;
 * “how should I structure this struct/JSON” is a data-shape question.
 */
export function asksForDesignAnswer(text: string): boolean {
  if (
    /\b(?:design|architect|model)\s+(?:the\s+|a\s+|an\s+)?(?:data\s+model|schema|api|architecture|system)\b|\bwhat(?:'s| is)\s+the\s+best\s+way\b/i.test(
      text
    )
  )
    return true
  const structural = text.match(
    /\bhow\s+(?:would|should|could|can|do|might)\s+(?:you|i|we|one)\s+(?:best\s+)?(?:design|structure|architect|approach|organi[sz]e|lay\s+out)\b(.{0,60})/i
  )
  if (!structural) return false
  // A language data shape is not an architecture deliverable.
  return !/^\s+(?:a|an|the|my|this)?\s*(?:struct|structs|data\s+structure|json|dict(?:ionary)?|array|list|tuple|enum|object\s+literal|type|interface|regex|sql\s+query)\b/i.test(
    structural[1] ?? ''
  )
}

/** The request names where code should land: a file path, the open project, or “here”. */
export function asksForCodeDestination(text: string): boolean {
  return (
    /\b(?:to|in|into|inside)\s+(?:the\s+)?[\w./-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|cpp|c|h|vue|svelte|css|html|json|ya?ml|toml|sql)\b/i.test(
      text
    ) ||
    /\b(?:to|in|into|inside)\s+(?:this|our|my|the)\s+(?:project|repo|repository|codebase|workspace|app|application|folder)\b/i.test(
      text
    ) ||
    /\b(?:add|apply|put|save)\s+it\b/i.test(text) ||
    /\b(?:build|create|scaffold)\b[\s\S]{0,40}\bhere\b/i.test(text)
  )
}

/** The user wants the implementation tested or validated, not merely reviewed. */
export function asksForVerification(text: string): boolean {
  const raw = text.trim()
  if (!raw || asksToImplementChanges(raw)) return false
  // “Write an implementation of seeding test data” asks for code. Combined
  // implement-and-test requests keep the implementation as the controlling action.
  if (leadsWithArtifactRequest(raw)) return false
  // “What's a good way to test X?” asks for testing advice, not a check of existing code.
  if (
    /^(?:what(?:'s| is)\s+(?:a|the)\s+(?:good|best|right)\s+way|how\s+(?:should|would|do|can)\s+(?:i|we|you))\s+(?:to\s+)?(?:test|verify|validate)\b/i.test(
      raw
    )
  )
    return false
  const t = withoutFeatureVerificationNouns(raw).trim()
  if (!t) return false
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
  // A review request phrased as “review the code, improve it for …” asks for
  // improvement advice. A separate “and improve/make changes” asks for edits.
  const reviewImprovementQuestion =
    /^(?:please\s+)?review\b[\s\S]{0,160}\bimprov(?:e|ements?)\b/i.test(t) &&
    !/\b(?:and|then)\s+(?:improve|make|apply|implement|fix|edit|change|update|code|write)\b/i.test(
      t
    ) &&
    !/\bmake\s+(?:those\s+|the\s+)?improvements?\b/i.test(t)
  if (reviewImprovementQuestion) return true
  if (
    /\b(make|apply|implement)\s+(the\s+|some\s+|these\s+)?improvements?\b/i.test(t) &&
    !/\bwhat\b/i.test(t)
  ) {
    return false
  }
  return (
    /\bwhat\b[\s\S]{0,48}\bimprov/i.test(t) ||
    /\b(list|suggest|recommend)\b[\s\S]{0,40}\b(improvements?|enhancements?|changes?|ideas)\b/i.test(
      t
    ) ||
    /\bconfirm\b[\s\S]{0,24}\b(improvements?|enhancements?)\b/i.test(t) ||
    (/\breview\b/i.test(t) && /\bwhat\b[\s\S]{0,48}\b(improv|should we)\b/i.test(t))
  )
}

/** A public-web question. The workspace cannot answer it. */
export function needsWebLookup(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    /\b(internet|on the web|online|search (?:the )?web|look up online|look up on the web)\b/i.test(
      t
    ) ||
    /\b(latest|current|recent|today|yesterday|this week|this month|as of now)\b[\s\S]{0,60}\b(news|price|prices|release|version|weather|schedule|policy|law|regulation|market|score|availability|status)\b/i.test(
      t
    ) ||
    /\bwho (is|was|are)\b/i.test(t)
  )
}

const SOURCE_EXTENSIONS =
  '(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|cpp|c|h|vue|svelte|css|scss|html|json|ya?ml|toml|sql|md)'
/** A path with a directory: src/auth/reset.ts, ./lib/x.py. */
const DIRECTORY_PATH = new RegExp(
  `(?:^|[\\s\`'"(])(?:\\.{0,2}\\/)?[\\w@-]+(?:\\/[\\w.@-]+)+\\.${SOURCE_EXTENSIONS}\\b`,
  'i'
)
/** A bare lowercase file name: reset.ts, api.ts. Technology names such as Node.js are not files. */
const BARE_FILE = new RegExp(
  `(?:^|[\\s\`'"(])(?!(?:node|next|nuxt|vue|express|three|d3|react|angular|ember|backbone|deno|chart|moment|socket)\\.js\\b)[a-z0-9_][\\w-]*\\.${SOURCE_EXTENSIONS}\\b`
)

/** The text names a workspace source file. */
export function mentionsSourcePath(text: string): boolean {
  return DIRECTORY_PATH.test(text) || BARE_FILE.test(text)
}

/** Workspace source paths named in the text, by the same rules as mentionsSourcePath. */
export function sourcePathsIn(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of [DIRECTORY_PATH, BARE_FILE]) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
    )
    for (const match of text.matchAll(global))
      found.add(match[0].replace(/^[\s`'"(]/, '').replace(/^\.\//, ''))
  }
  return [...found]
}

/**
 * Drop a leading scope phrase (“In the shop app, …”) so the imperative that
 * follows is read as the request's action. The project name stays in the text
 * used for scope resolution.
 */
export function withoutLeadingScope(text: string): string {
  return text
    .trim()
    .replace(
      /^(?:in|for|on|inside)\s+(?:the\s+)?[\w-]+(?:\s+[\w-]+){0,2}\s+(?:app|application|project|website|site|repo|package|service)\s*,\s*/i,
      ''
    )
}

/** Questions whose answer should be grounded in the open workspace. */
export function asksWorkspaceQuestion(text: string, fileNames: string[] = []): boolean {
  const t = text.trim()
  if (!t) return false
  if (
    mentionsSourcePath(t) ||
    /\b(this|that|the|my|our)\s+(project|repo|repository|workspace|codebase|app|application|folder|file|code|component|function|service|api)\b/i.test(
      t
    ) ||
    /\b(where is|which file|what file|find (?:the )?(?:file|function|class|component)|in the (?:repo|project|workspace))\b/i.test(
      t
    ) ||
    /\b(stack trace|test failure|build error|source code|bug|exception|crash(?:es|ed|ing)?|fail(?:s|ed|ing)?|broken|not working|doesn't work|compile error|compiler error|import error)\b/i.test(
      t
    )
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
  if (asksToImplementChanges(text) || /\b(fix|change|edit|implement|update|apply)\b/i.test(text)) {
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
  if (needsWebLookup(text)) return 'explainer'
  if (asksWhatTheProjectDoes(text)) return 'explainer'
  if (options.intent === 'review') return 'reviewer'
  if (options.intent === 'edit' || options.intent === 'run') return 'composer'
  if (options.intent === 'explore') return shortLookup ? 'fast' : 'explainer'
  if (explains) return 'explainer'
  // Deliverable complexity, not message length, picks the worker: a short ask for code
  // or a design still needs room for the whole artifact.
  if (asksForCodeExample(text) || asksForDesignAnswer(text)) return 'explainer'
  // Fast is for short lookups. A short question about how to design or build something
  // still asks for a structured answer that a one-to-three-sentence contract cannot hold.
  if (
    text.length > 0 &&
    text.length < 80 &&
    !/\b(?:design|approach|pattern|architect\w*|structure|walk\s+me\s+through|way\s+to|implement\w*|build\w*|add|handle|help)\b/i.test(
      text
    )
  )
    return 'fast'
  return 'explainer'
}
