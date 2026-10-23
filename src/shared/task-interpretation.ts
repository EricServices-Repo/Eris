import type { ChatIntent } from './settings-schema'
import type {
  ArtifactDestination,
  ScopeApplicability,
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

/** Placeholder for a quoted shell command the surrounding instruction refers to. */
export const COMMAND_OPERAND = '⟦cmd⟧'

const COMMAND_START =
  /^(?:npm|npx|pnpm|yarn|bun|node|deno|pytest|python3?|pip3?|cargo|go|make|docker|git|gradle|mvn|dotnet|bundle|rake|rspec|jest|vitest|tsc|eslint|composer|php|ruby|swift|xcodebuild|uv|poetry)\b/i

/** One quoted or fenced span: data the instruction may refer to, never an instruction itself. */
export interface QuotedOperand {
  kind: 'fence' | 'inline' | 'quote'
  text: string
  role: 'command' | 'language' | 'path' | 'data'
}

export interface RequestSpans {
  /** The user's own words, with quoted data removed or replaced by a typed operand marker. */
  instruction: string
  operands: QuotedOperand[]
  /** The message has content, but none of it is outside quotes or fences. */
  quotedOnly: boolean
}

function operandRole(kind: QuotedOperand['kind'], text: string): QuotedOperand['role'] {
  const t = text.trim()
  if (kind !== 'fence' && LANGUAGE_NAMES.has(t.toLowerCase())) return 'language'
  if (kind !== 'fence' && /^[\w@./-]+\.[a-z0-9]{1,8}$/i.test(t) && !/\s/.test(t)) return 'path'
  if (kind === 'inline' && COMMAND_START.test(t) && !/\n/.test(t)) return 'command'
  return 'data'
}

/**
 * Split a request into the user's instruction and the quoted data it refers to.
 * Verbs inside `write_file`, “Delete all files” in a fence, or a pasted command are
 * content, not requests. The surrounding instruction can still bind them as operands:
 * a quoted language name or file path stays readable, and a quoted command becomes
 * a marker that “Run …” can refer to. A quoted command is never scanned on its own.
 */
export function requestSpans(text: string): RequestSpans {
  const operands: QuotedOperand[] = []
  const keep = (kind: QuotedOperand['kind'], body: string) => {
    const role = operandRole(kind, body)
    operands.push({ kind, text: body, role })
    if (role === 'language' || role === 'path') return ` ${body.trim()} `
    if (role === 'command') return ` ${COMMAND_OPERAND} `
    return ' '
  }
  const instruction = text
    .replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, body: string) => keep('fence', body))
    .replace(/`([^`\n]*)`/g, (_, body: string) => keep('inline', body))
    .replace(/"([^"\n]{1,200})"/g, (_, body: string) => keep('quote', body))
    .replace(/“([^”\n]{1,200})”/g, (_, body: string) => keep('quote', body))
    .replace(/\s+/g, ' ')
    .trim()
  return { instruction, operands, quotedOnly: !instruction && /\S/.test(text) }
}

/**
 * The user's own words with quoted and fenced material removed. Empty when the
 * whole message is quoted; callers must not fall back to the quoted text.
 */
export function requestTextForIntent(text: string): string {
  return requestSpans(text).instruction
}

/** The message is only quoted or fenced content, with no instruction around it. */
export function isQuotedContentOnly(text: string): boolean {
  return requestSpans(text).quotedOnly
}

export type ForbiddenEffect = 'edit' | 'verification' | 'execution' | 'commit' | 'external'

/** Effects the request forbids, each with the phrase that forbade it. */
export interface EffectConstraints {
  edit: boolean
  /** Running tests, typecheck, lint or build. */
  verification: boolean
  /** Running any command. */
  execution: boolean
  commit: boolean
  /** Pushing, deploying, publishing, or other effects outside the workspace. */
  external: boolean
  trace: Array<{ phrase: string; effects: ForbiddenEffect[] }>
}

const NEGATION =
  /\b(?:do\s+not|don['’]t|dont|never|without|no\s+need\s+to|avoid|refrain\s+from)\s+((?:(?:any|anything|the|any\s+of\s+the|actually|yet|please|ever|really|make|making|me|you)\s+){0,3})(edit(?:s|ing)?|chang(?:e|es|ing)|modif(?:y|ying|ications?)|touch(?:ing)?|writ(?:e|ing)|apply(?:ing)?|delet(?:e|ing)|renam(?:e|ing)|commit(?:ting)?|push(?:ing)?|deploy(?:ing)?|publish(?:ing)?|run(?:ning)?|execut(?:e|ing)|launch(?:ing)?|start(?:ing)?|test(?:ing)?|build(?:ing)?)\b((?:\s+(?!(?:and|but|or|nor|then|never|so)\b)[\w-]+){0,3})/gi

const WORKSPACE_OBJECT =
  /^\s+(?:(?:any|the|my|our|this|these|those|your|its)\s+)*(?:files?|code(?:base)?|repo(?:sitory)?|workspace|project|source|anything(?!\s+else)|it|them|nothing)\b/i
const VERIFICATION_OBJECT =
  /\b(?:tests?|specs?|test\s+suite|typecheck|type-?check|lint(?:er)?|build|checks?|ci)\b/i

/**
 * “Fix the bug but do not run tests” forbids running checks, not the patch.
 * “Run tests without changing files” forbids edits, not the check. “Do not change
 * anything” forbids both. Each effect is recorded with the phrase that denied it.
 */
export function effectConstraints(text: string): EffectConstraints {
  const t = requestTextForIntent(text)
  const out: EffectConstraints = {
    edit: false,
    verification: false,
    execution: false,
    commit: false,
    external: false,
    trace: []
  }
  const deny = (phrase: string, effects: ForbiddenEffect[]) => {
    for (const effect of effects) out[effect] = true
    out.trace.push({ phrase: phrase.trim(), effects })
  }
  for (const match of t.matchAll(NEGATION)) {
    const verb = match[2]!.toLowerCase()
    const object = (match[1] ?? '') + (match[3] ?? '')
    const everything = /\banything\b(?!\s+else)/i.test(object) && !/\bfiles?\b/i.test(object)
    if (/^(?:commit)/.test(verb)) deny(match[0], ['commit'])
    else if (/^(?:push|deploy|publish)/.test(verb)) deny(match[0], ['commit', 'external'])
    else if (/^(?:run|execut|launch|start)/.test(verb))
      deny(
        match[0],
        VERIFICATION_OBJECT.test(match[3] ?? '') ? ['verification'] : ['verification', 'execution']
      )
    else if (/^(?:test|build)/.test(verb)) deny(match[0], ['verification'])
    else if (everything) deny(match[0], ['edit', 'verification', 'execution'])
    // “Without changing the public API” or “don't touch anything else” limits the
    // patch; it does not forbid one. Only the workspace as a whole, or no object, does.
    else if (WORKSPACE_OBJECT.test(match[3] ?? '') || !(match[3] ?? '').trim())
      deny(match[0], ['edit'])
    else out.trace.push({ phrase: match[0].trim(), effects: [] })
  }
  const readOnly = t.match(
    /\bread[\s-]only\b|\bno\s+(?:file\s+)?(?:edits|changes|modifications)\b|\bjust\s+(?:look|read)\b/i
  )
  if (readOnly) deny(readOnly[0], ['edit'])
  return out
}

/** “Do not edit”, “without changing anything”. Run-only prohibitions do not forbid edits. */
export function forbidsMutation(text: string): boolean {
  return effectConstraints(text).edit
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
const LANGUAGE_NAMES = new Set([
  'typescript',
  'ts',
  'javascript',
  'js',
  'node',
  'node.js',
  'nodejs',
  'python',
  'java',
  'kotlin',
  'go',
  'golang',
  'rust',
  'php',
  'ruby',
  'c#',
  'csharp',
  'swift',
  'c++',
  'cpp'
])
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

/** Languages named outright; framework names only imply a language. */
const FRAMEWORK_IMPLIED = new Set(['Python', 'Java', 'PHP', 'Ruby', 'C#'])
const EXPLICIT_LANGUAGES: Array<[string, RegExp]> = LANGUAGES.map(([name, pattern]) =>
  FRAMEWORK_IMPLIED.has(name)
    ? [
        name,
        {
          Python: /\bpython\b/i,
          Java: /\bjava\b(?!script)/i,
          PHP: /\bphp\b/i,
          Ruby: /\bruby\b/i,
          'C#': /\bc#|\bcsharp\b/i
        }[name as 'Python']
      ]
    : [name, pattern]
)

function languageAt(
  text: string,
  table: Array<[string, RegExp]>
): Array<{ name: string; index: number; match: string }> {
  const found: Array<{ name: string; index: number; match: string }> = []
  for (const [name, pattern] of table) {
    const global = new RegExp(pattern.source, pattern.flags + 'g')
    for (const match of text.matchAll(global))
      found.push({ name, index: match.index ?? 0, match: match[0] })
  }
  return found.sort((a, b) => a.index - b.index)
}

/** Source and target language as separate roles, with any ambiguity kept visible. */
export interface LanguageRoles {
  /** The language the answer or patch must be written in. */
  target: string | null
  /** The language being converted from, when the request is a conversion. */
  source: string | null
  /** Distinct explicitly named languages that leave the target undecided. */
  ambiguous: string[]
}

const CONVERSION =
  /\b(?:convert|port|translate|rewrite|migrate|transpile|turn)\b[\s\S]{0,80}?\b(?:to|into)\s+(?:idiomatic\s+|modern\s+)?([\w#+.]+)/i

/**
 * “Convert this Python example to TypeScript” has a source and a target; the first
 * language mentioned is not the target. Explicit names outrank framework-implied ones,
 * and frameworks from different ecosystems leave the language to the frameworks.
 */
export function languageRoles(text: string): LanguageRoles {
  const t = requestTextForIntent(text)
  const named = languageAt(t, EXPLICIT_LANGUAGES)
  const conversion = t.match(CONVERSION)
  if (conversion) {
    const targetIndex = (conversion.index ?? 0) + conversion[0].length - conversion[1]!.length
    // The conversion's object names the target, even a bare “Go” the general table skips.
    const token = conversion[1]!.toLowerCase()
    const target =
      (token === 'go' || token === 'golang'
        ? 'Go'
        : EXPLICIT_LANGUAGES.find(([, pattern]) => pattern.test(conversion[1]!))?.[0]) ??
      named.find((item) => item.index >= targetIndex)?.name ??
      null
    const source = named.find((item) => item.index < targetIndex && item.name !== target)?.name
    if (target) return { target, source: source ?? null, ambiguous: [] }
  }
  // “… in Java”, “using Go”, “a Rust version” name the target directly.
  const directed = named.find(
    (item) =>
      /^(?:in|using|with)\s/i.test(item.match) ||
      /\b(?:in|using|with|as)\s+(?:idiomatic\s+|modern\s+|plain\s+)?$/i.test(
        t.slice(0, item.index)
      ) ||
      /^\S+\s+(?:version|implementation|example|code)\b/i.test(t.slice(item.index))
  )
  const distinct = [...new Set(named.map((item) => item.name))]
  if (directed) return { target: directed.name, source: null, ambiguous: [] }
  if (distinct.length > 1) return { target: distinct[0]!, source: null, ambiguous: distinct }
  if (distinct.length === 1) return { target: distinct[0]!, source: null, ambiguous: [] }
  // Only framework-implied: one ecosystem decides the language; two leave it open.
  const implied = [...new Set(languageAt(t, LANGUAGES).map((item) => item.name))]
  const frameworks = requestedFrameworks(text)
  const families = new Set(frameworks.map((name) => FRAMEWORK_LANGUAGES[name]?.[0] ?? name))
  if (families.size > 1) return { target: null, source: null, ambiguous: [] }
  return { target: implied[0] ?? null, source: null, ambiguous: [] }
}

/** The language the reply or patch must use. See languageRoles for the source language. */
export function requestedLanguage(text: string): string | null {
  return languageRoles(text).target
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
  const t = requestTextForIntent(text)
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
  const roles = languageRoles(input.text)
  const language = roles.target
  const constraints = effectConstraints(input.text)
  return {
    revision: input.revision,
    artifact,
    destination,
    obligations: requestObligations(input.text, artifact, language),
    language,
    ...(roles.source ? { sourceLanguage: roles.source } : {}),
    ...(roles.ambiguous.length ? { languageAmbiguity: roles.ambiguous } : {}),
    frameworks: requestedFrameworks(input.text),
    forbidsMutation: constraints.edit,
    ...(constraints.trace.length ? { constraints } : {}),
    conceptFit: conceptFit(requestTextForIntent(input.text), language),
    route: input.route ?? { heuristicRule: 'unknown', overrides: [] }
  }
}

/**
 * What the reply must contain for the requested artifact. This outranks worker
 * style defaults such as Fast's sentence limit or Plan's ordered-steps format.
 */
export function artifactResponseContract(
  interpretation: TaskInterpretation,
  applicability?: ScopeApplicability
): string {
  const stack = [interpretation.language, ...interpretation.frameworks].filter(Boolean).join(', ')
  const inStack =
    (stack ? ` Use ${stack} as requested, even if the open project uses another stack.` : '') +
    (interpretation.sourceLanguage && interpretation.language
      ? ` Convert from ${interpretation.sourceLanguage} to ${interpretation.language}; the result is ${interpretation.language}, not ${interpretation.sourceLanguage}.`
      : '') +
    (interpretation.languageAmbiguity?.length
      ? ` The request names ${interpretation.languageAmbiguity.join(' and ')}; state which language each part uses.`
      : '')
  const lines: Record<RequestedArtifact, string> = {
    'code-example': `RESPONSE CONTRACT — code example in chat. Include complete, runnable code in a fenced block with its imports or dependencies, then brief notes on usage and limitations. Keep it concise but do not truncate the code to fit a sentence limit; do not reply with only a plan of future steps. This outranks any brevity rule in role text.${inStack}`,
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
  const forbids = constraintLines(interpretation)
  const scope = scopeAndStackGuidance(interpretation, applicability)
  return lines[interpretation.artifact] + obligations + forbids + (scope ? `\n${scope}` : '')
}

/**
 * One line per forbidden effect, so “do not run tests” never reads as “do not edit”.
 * Contracts saved before constraints existed keep their single read-only line.
 */
function constraintLines(interpretation: TaskInterpretation): string {
  const c = interpretation.constraints
  if (!c) {
    return interpretation.forbidsMutation
      ? '\nThe user asked for no edits or commands. Do not change files or run anything.'
      : ''
  }
  const lines: string[] = []
  if (c.edit) lines.push('Do not change files.')
  if (c.execution) lines.push('Do not run commands.')
  else if (c.verification) lines.push('Do not run tests, typecheck, lint or builds.')
  if (c.commit) lines.push('Do not commit.')
  if (c.external) lines.push('Do not push, deploy or publish.')
  if (!lines.length) return ''
  const quoted = c.trace
    .filter((item) => item.effects.length)
    .map((item) => `“${item.phrase}”`)
    .join(', ')
  return `\nThe user restricted effects (${quoted}). ${lines.join(' ')}`
}

const FRAMEWORK_LANGUAGES: Record<string, string[]> = {
  Django: ['Python'],
  Flask: ['Python'],
  FastAPI: ['Python'],
  Rails: ['Ruby'],
  Laravel: ['PHP'],
  'Next.js': ['TypeScript', 'JavaScript'],
  React: ['TypeScript', 'JavaScript'],
  Vue: ['TypeScript', 'JavaScript'],
  Express: ['TypeScript', 'JavaScript'],
  Spring: ['Java', 'Kotlin'],
  'ASP.NET': ['C#']
}
/** Concepts tied to one ecosystem, so a request in another language needs an analogue. */
const ECOSYSTEM_CONCEPTS: Array<{ concept: string; pattern: RegExp; ecosystem: string }> = [
  { concept: 'error boundaries', pattern: /\berror\s+boundar(?:y|ies)\b/i, ecosystem: 'React' },
  {
    concept: 'React hooks',
    pattern: /\breact\s+hooks?\b|\buse(?:Effect|State|Memo)\b/,
    ecosystem: 'React'
  },
  { concept: 'Django migrations', pattern: /\bdjango\s+migrations?\b/i, ecosystem: 'Django' }
]

/** A requested ecosystem-specific concept in a language that ecosystem does not use. */
export function conceptFit(
  text: string,
  language: string | null
): TaskInterpretation['conceptFit'] {
  if (!language) return null
  for (const item of ECOSYSTEM_CONCEPTS) {
    if (!item.pattern.test(text)) continue
    if (!FRAMEWORK_LANGUAGES[item.ecosystem]?.includes(language))
      return { concept: item.concept, ecosystem: item.ecosystem, requestedLanguage: language }
  }
  return null
}

/** Requested stack against the observed project stack, for chat artifacts and patches alike. */
export function stackFit(
  interpretation: Pick<TaskInterpretation, 'language' | 'frameworks'>,
  project: TaskInterpretation['projectStack']
): NonNullable<TaskInterpretation['stackFit']> {
  if (!interpretation.language && !interpretation.frameworks.length) return 'not-applicable'
  if (!project || (!project.languages.length && !project.frameworks.length)) return 'unknown'
  const languageOk =
    !interpretation.language ||
    project.languages.includes(interpretation.language) ||
    // TypeScript projects run JavaScript and the reverse is a small step.
    (['TypeScript', 'JavaScript'].includes(interpretation.language) &&
      project.languages.some((item) => ['TypeScript', 'JavaScript'].includes(item)))
  const frameworksOk = interpretation.frameworks.every((item) => project.frameworks.includes(item))
  return languageOk && frameworksOk ? 'match' : 'mismatch'
}

/** Guidance that keeps an unrelated project and mismatched stacks from shaping the answer. */
export function scopeAndStackGuidance(
  interpretation: TaskInterpretation,
  applicability: ScopeApplicability | undefined
): string {
  const lines: string[] = []
  if (applicability === 'generic')
    lines.push(
      'This request does not depend on the open project. Do not cite its files as implementing the request or as evidence for it.'
    )
  if (interpretation.stackFit === 'mismatch' && interpretation.projectStack) {
    const project = [
      ...interpretation.projectStack.languages,
      ...interpretation.projectStack.frameworks
    ]
    const requested = [interpretation.language, ...interpretation.frameworks].filter(Boolean)
    lines.push(
      interpretation.destination === 'chat'
        ? `The open project uses ${project.join(', ') || 'another stack'}; answer in ${requested.join(', ')} as requested.`
        : `The request names ${requested.join(', ')} but the project uses ${project.join(', ')}. State the assumption or ask which stack to use before editing.`
    )
  }
  if (interpretation.conceptFit) {
    const fit = interpretation.conceptFit
    lines.push(
      `${fit.concept} are a ${fit.ecosystem} concept. In ${fit.requestedLanguage}, implement the closest idiomatic analogue and state its limits; do not invent ${fit.ecosystem} APIs in ${fit.requestedLanguage}.`
    )
  }
  return lines.join('\n')
}
