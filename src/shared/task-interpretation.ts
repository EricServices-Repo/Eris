import type { ChatIntent } from './settings-schema'
import type {
  ArtifactDestination,
  RequestedArtifact,
  TaskInterpretation,
  TaskObligation
} from './task-contract'
import {
  asksForCodeDestination,
  asksForCodeExample,
  asksForPlan,
  asksForRecommendations
} from './agent-contract'

/**
 * The user's own words with quoted and fenced material removed. Action verbs
 * inside `write_file`, "run npm test" or a pasted code block are content, not requests.
 */
export function requestTextForIntent(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]{1,200}"/g, ' ')
    .replace(/“[^”\n]{1,200}”/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** “Do not edit”, “without changing anything”, “don't run it”. */
export function forbidsMutation(text: string): boolean {
  return /\b(?:do\s+not|don['’]t|dont|never|without)\s+(?:\w+\s+){0,2}?(?:edit(?:ing)?|chang(?:e|ing)|modify(?:ing)?|touch(?:ing)?|writ(?:e|ing)|apply(?:ing)?|commit(?:ting)?|run(?:ning)?|execut(?:e|ing))\b/i.test(
    requestTextForIntent(text)
  )
}

const LANGUAGES: Array<[string, RegExp]> = [
  ['TypeScript', /\btypescript\b|\bts\b(?=\s+(?:version|example|code|implementation))/i],
  ['JavaScript', /\bjavascript\b|\bnode\.?js\b/i],
  ['Python', /\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b/i],
  ['Java', /\bjava\b(?!script)|\bspring(?:\s+boot)?\b/i],
  ['Kotlin', /\bkotlin\b/i],
  [
    'Go',
    /\bgolang\b|\b(?:in|using|with)\s+go\b|\bgo\s+(?:version|example|code|implementation|service)\b/i
  ],
  ['Rust', /\brust\b/i],
  ['PHP', /\bphp\b|\blaravel\b/i],
  ['Ruby', /\bruby\b|\brails\b/i],
  ['C#', /\bc#|\bcsharp\b|\.net\b|\basp\.net\b/i],
  ['Swift', /\bswift\b/i],
  ['C++', /\bc\+\+|\bcpp\b/i]
]
const FRAMEWORKS: Array<[string, RegExp]> = [
  ['Django', /\bdjango\b/i],
  ['Flask', /\bflask\b/i],
  ['FastAPI', /\bfastapi\b/i],
  ['Rails', /\brails\b/i],
  ['Laravel', /\blaravel\b/i],
  ['Next.js', /\bnext\.?js\b/i],
  ['React', /\breact\b/i],
  ['Vue', /\bvue\b/i],
  ['Express', /\bexpress(?:\.js)?\b/i],
  ['Spring', /\bspring(?:\s+boot)?\b/i],
  ['ASP.NET', /\basp\.net\b/i]
]

/** The first explicitly named language. Framework names imply their language. */
export function requestedLanguage(text: string): string | null {
  const t = requestTextForIntent(text)
  let best: { name: string; index: number } | null = null
  for (const [name, pattern] of LANGUAGES) {
    const index = t.search(pattern)
    if (index >= 0 && (!best || index < best.index)) best = { name, index }
  }
  return best?.name ?? null
}

export function requestedFrameworks(text: string): string[] {
  const t = requestTextForIntent(text)
  return FRAMEWORKS.filter(([, pattern]) => pattern.test(t)).map(([name]) => name)
}

/** The request includes writing tests alongside the main deliverable. */
export function asksForTests(text: string): boolean {
  return /\b(?:with|and|plus|including|include|add)\s+(?:\w+\s+){0,2}?(?:unit\s+|integration\s+)?(?:tests|test\s+coverage|test\s+cases|specs)\b|\b(?:the\s+)?tests\s+for\s+it\b|\bwrite\s+(?:\w+\s+){0,3}?tests\b/i.test(
    requestTextForIntent(text)
  )
}

/** Schema, architecture or API design — an answer with structure and tradeoffs. */
export function asksForDesign(text: string): boolean {
  return /\b(?:design|architect|model)\s+(?:the\s+|a\s+|an\s+)?(?:data\s+model|schema|api|architecture|system)\b|\bhow\s+would\s+you\s+(?:design|structure|architect|approach)\b|\bwhat(?:'s| is)\s+the\s+best\s+way\b/i.test(
    requestTextForIntent(text)
  )
}

/** Greenfield: “build a new app here”, “scaffold a project”. */
export function asksForNewProject(text: string): boolean {
  return /\b(?:new|greenfield)\s+(?:app|application|project|website|site|package|repo)\b|\bscaffold\b|\bfrom\s+scratch\b/i.test(
    requestTextForIntent(text)
  )
}

/**
 * The requested artifact and its destination. Intent decides which worker runs;
 * the artifact decides what the reply must contain.
 */
export function requestedArtifact(
  text: string,
  intent: ChatIntent,
  canEdit: boolean
): { artifact: RequestedArtifact; destination: ArtifactDestination } {
  const t = requestTextForIntent(text) || text
  const chat = (artifact: RequestedArtifact) => ({ artifact, destination: 'chat' as const })
  if (intent === 'review') return chat('review')
  if (intent === 'verify' || intent === 'run') return chat('execution-report')
  if (intent === 'edit' && canEdit)
    return { artifact: 'patch', destination: asksForNewProject(t) ? 'new-project' : 'workspace' }
  if (asksForCodeExample(t) && !asksForCodeDestination(t)) return chat('code-example')
  if (intent === 'plan') return chat(asksForPlan(t) || !asksForDesign(t) ? 'plan' : 'design')
  if (asksForRecommendations(t)) return chat('review')
  if (asksForDesign(t)) return chat('design')
  return chat('explanation')
}

/** Ordered, separately checkable obligations. Unstated features are never added. */
export function requestObligations(
  text: string,
  artifact: RequestedArtifact,
  language: string | null
): TaskObligation[] {
  const stack = language ? `${language} ` : ''
  const out: TaskObligation[] = []
  const add = (kind: TaskObligation['kind'], value: string) =>
    out.push({ id: `${kind}-${out.length + 1}`, kind, text: value })
  switch (artifact) {
    case 'code-example':
      add(
        'implementation',
        `Include a complete ${stack}example of the requested behavior in the reply.`
      )
      break
    case 'patch':
      add('implementation', 'Apply the requested behavior to the workspace files.')
      break
    case 'design':
      add('design', 'Describe the design with its data structures, interfaces, and tradeoffs.')
      break
    case 'plan':
      add('plan', 'Return ordered steps with affected files, risks, and completion checks.')
      break
    case 'review':
      add('review', 'Report findings with paths, impact, and suggested fixes.')
      break
    case 'execution-report':
      add('verification', 'Report the checks or commands run and their observed results.')
      break
    default:
      add('answer', 'Answer the question directly.')
  }
  if (asksForTests(text) && (artifact === 'code-example' || artifact === 'patch'))
    add(
      'tests',
      artifact === 'patch'
        ? 'Add tests for the requested behavior and report their run result.'
        : 'Include tests for the requested behavior in the reply.'
    )
  return out
}

export function interpretRequest(input: {
  text: string
  intent: ChatIntent
  canEdit: boolean
  revision: number
  route?: TaskInterpretation['route']
}): TaskInterpretation {
  const { artifact, destination } = requestedArtifact(input.text, input.intent, input.canEdit)
  const language = requestedLanguage(input.text)
  return {
    revision: input.revision,
    artifact,
    destination,
    obligations: requestObligations(input.text, artifact, language),
    language,
    frameworks: requestedFrameworks(input.text),
    forbidsMutation: forbidsMutation(input.text),
    route: input.route ?? { heuristicRule: 'unknown', overrides: [] }
  }
}

/**
 * What the reply must contain for the requested artifact. This outranks worker
 * style defaults such as Fast's sentence limit or Plan's ordered-steps format.
 */
export function artifactResponseContract(interpretation: TaskInterpretation): string {
  const stack = [interpretation.language, ...interpretation.frameworks].filter(Boolean).join(', ')
  const inStack = stack
    ? ` Use ${stack} as requested, even if the open project uses another stack.`
    : ''
  const lines: Record<RequestedArtifact, string> = {
    'code-example': `RESPONSE CONTRACT — code example in chat. Include complete, runnable code in a fenced block with its imports or dependencies, then brief notes on usage and limitations. Keep it concise but do not truncate the code to fit a sentence limit; do not reply with only a plan of future steps.${inStack}`,
    design: `RESPONSE CONTRACT — design answer. Describe the data structures or schema, interfaces or endpoints, and the main tradeoffs. Ordered implementation steps are optional.${inStack}`,
    plan: 'RESPONSE CONTRACT — plan. Return ordered steps with affected files, dependencies, risks, and a completion check for each.',
    review:
      'RESPONSE CONTRACT — review. Report findings with paths, impact, and suggested fixes, ordered by severity.',
    patch: `RESPONSE CONTRACT — patch. Apply the change with tools, then summarize the files actually changed and the verification observed.${inStack}`,
    'execution-report':
      'RESPONSE CONTRACT — execution report. State each check or command run and its observed result; never report an unobserved pass.',
    explanation: `RESPONSE CONTRACT — explanation. Answer the question directly at the depth it asks for.${inStack}`
  }
  const obligations = interpretation.obligations.length
    ? `\nObligations, each checked separately:\n${interpretation.obligations.map((o, i) => `${i + 1}. ${o.text}`).join('\n')}`
    : ''
  const forbids = interpretation.forbidsMutation
    ? '\nThe user asked for no edits or commands. Do not change files or run anything.'
    : ''
  return lines[interpretation.artifact] + obligations + forbids
}
