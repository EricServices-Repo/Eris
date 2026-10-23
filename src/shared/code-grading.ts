import type { TopicRubric } from './topic-rubrics'

/**
 * Deterministic grading of a code-example answer: a nonempty fenced block exists in
 * the requested language, and that block's code — not its comments, strings, or
 * another language's block — mentions the rubric's core behaviors. This is a review
 * heuristic over code tokens; it does not parse, compile or run the code, so a pass
 * here is keyword evidence, never behavioral evidence (see FR-039).
 */
export interface CodeExampleGrade {
  /** A block with executable content: not empty, not only comments, TODOs or strings. */
  hasCode: boolean
  /** Fence tags found, lowercased. */
  languages: string[]
  languageOk: boolean | null
  covered: string[]
  /** Core behaviors not shown. Any entry fails the example. */
  missingCore: string[]
  /** Non-core behaviors not shown; reported as gaps. */
  gaps: string[]
  /**
   * Keyword coverage over the whole answer, comments and prose included. Kept as a
   * separate diagnostic so a textual hint never reads as implementation evidence.
   */
  keywordCoverage: string[]
  /** Setup errors (unknown rubric, unresolved behavior labels). Present → verdict 'invalid'. */
  configErrors?: string[]
  /** Reasons the target block looks wrong, e.g. another language's syntax under its tag. */
  review?: string[]
  verdict: 'pass' | 'fail' | 'review' | 'invalid'
  method: 'keyword-heuristic'
}

/** Requested behavior labels that the rubric does not define, and duplicates. */
export function codeExampleConfigErrors(
  rubricId: string | undefined,
  rubric: TopicRubric | undefined,
  behaviors: string[] | undefined
): string[] {
  const errors: string[] = []
  if (rubricId && !rubric) errors.push(`Unknown rubric “${rubricId}”.`)
  if (behaviors) {
    if (!behaviors.length) errors.push('An explicit behavior filter is empty.')
    const seen = new Set<string>()
    for (const label of behaviors) {
      if (seen.has(label)) errors.push(`Duplicate behavior “${label}”.`)
      seen.add(label)
      if (!rubric) {
        errors.push(`Behavior “${label}” has no rubric to resolve against.`)
        continue
      }
      if (!rubric.behaviors.some((behavior) => behavior.label === label))
        errors.push(`Rubric ${rubric.id} has no behavior “${label}”.`)
    }
  }
  return errors
}

const SQL = /\b(?:select\s+[\w*]|update\s+\w+\s+set|insert\s+into|delete\s+from|where\s+\w+)/i

/** Code with comments and string literals removed, so only code tokens count. */
export function codeTokens(code: string, language: string): string {
  const hashComments = ['py', 'python', 'rb', 'ruby', 'sh', 'bash', 'yaml', 'yml', 'toml'].includes(
    language
  )
  return (
    code
      // Block comments and docstrings.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/("""|''')[\s\S]*?\1/g, ' ')
      // Line comments.
      .replace(hashComments ? /#.*$/gm : /\/\/.*$/gm, ' ')
      // String and template literals, except embedded SQL, which is code in a string.
      .replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (literal) =>
        SQL.test(literal) ? literal : '""'
      )
      // Unreachable branches: `if (false) { … }`, `if False:` bodies.
      .replace(/\bif\s*\(\s*(?:false|0)\s*\)\s*\{[^{}]*\}/g, ' ')
      .replace(/^(\s*)if\s+False\s*:\s*\n(?:\1[ \t]+.*\n?)*/gm, ' ')
  )
}

/** Something a reader could run: not only comments, TODOs, `pass`, or empty declarations. */
function hasExecutableContent(tokens: string): boolean {
  const meaningful = tokens
    .replace(/\b(?:pass|TODO|FIXME|\.\.\.)\b|\.\.\./g, ' ')
    .replace(/[{}()[\];,\s]/g, '')
  return meaningful.length >= 8
}

const FOREIGN_SYNTAX: Record<string, RegExp> = {
  typescript: /^\s*def\s+\w+\s*\(.*\)\s*(?:->.*)?:\s*$|^\s*fn\s+\w+\s*\(|^\s*func\s+\w+\s*\(/m,
  javascript: /^\s*def\s+\w+\s*\(.*\)\s*(?:->.*)?:\s*$|^\s*fn\s+\w+\s*\(|^\s*func\s+\w+\s*\(/m,
  python: /^\s*(?:const|let|function|interface)\s+\w+|^\s*(?:public|private)\s+(?:static\s+)?\w+[\w<>[\]]*\s+\w+\s*\(/m,
  go: /^\s*def\s+\w+\s*\(|^\s*(?:const|let)\s+\w+\s*=|^\s*function\s+\w+/m,
  rust: /^\s*def\s+\w+\s*\(|^\s*function\s+\w+|^\s*func\s+\w+\s*\(/m,
  java: /^\s*def\s+\w+\s*\(|^\s*(?:const|let)\s+\w+\s*=|^\s*function\s+\w+/m
}

const FENCE = /```([\w#+.-]*)[^\n]*\n([\s\S]*?)```/g

const ALIASES: Record<string, string[]> = {
  typescript: ['ts', 'typescript', 'tsx'],
  javascript: ['js', 'javascript', 'jsx', 'mjs', 'node'],
  python: ['py', 'python'],
  java: ['java'],
  kotlin: ['kt', 'kotlin'],
  go: ['go', 'golang'],
  rust: ['rs', 'rust'],
  php: ['php'],
  ruby: ['rb', 'ruby'],
  'c#': ['cs', 'csharp', 'c#'],
  swift: ['swift'],
  'c++': ['cpp', 'c++', 'cc']
}

export function codeBlocks(answer: string): Array<{ language: string; code: string }> {
  return [...answer.matchAll(FENCE)].map((match) => ({
    language: (match[1] ?? '').toLowerCase(),
    code: match[2] ?? ''
  }))
}

export function gradeCodeExample(
  answer: string,
  options: {
    language?: string | null
    rubric?: TopicRubric
    behaviors?: string[]
    /** The rubric ID the caller asked for, so an unknown ID is reported, not ignored. */
    rubricId?: string
  } = {}
): CodeExampleGrade {
  const blocks = codeBlocks(answer)
  const wanted = options.language?.toLowerCase()
  const accepted = wanted ? (ALIASES[wanted] ?? [wanted]) : []
  const languages = [...new Set(blocks.map((block) => block.language).filter(Boolean))]
  const withTokens = blocks.map((block) => ({
    ...block,
    tokens: codeTokens(block.code, block.language)
  }))
  const runnable = withTokens.filter((block) => hasExecutableContent(block.tokens))
  // The implementation is the nonempty block in the requested language. Supporting
  // blocks (a JSON config, another language) never satisfy the language or core behaviors.
  const target = wanted ? runnable.filter((block) => accepted.includes(block.language)) : runnable
  const languageOk = wanted ? target.length > 0 : null
  const code = target.map((block) => block.tokens).join('\n')
  const configErrors = codeExampleConfigErrors(options.rubricId, options.rubric, options.behaviors)
  const behaviors = (options.rubric?.behaviors ?? []).filter(
    (behavior) => !options.behaviors || options.behaviors.includes(behavior.label)
  )
  // Core behaviors must appear in code tokens of the target block. Non-core behaviors
  // may be explained beside it. Whole-answer keyword hits are kept separately.
  const covered: string[] = []
  const missingCore: string[] = []
  const gaps: string[] = []
  const keywordCoverage: string[] = []
  for (const behavior of behaviors) {
    if (behavior.pattern.test(answer)) keywordCoverage.push(behavior.label)
    const inCode = behavior.pattern.test(code)
    const inAnswer = inCode || behavior.pattern.test(answer)
    if (behavior.core ? inCode : inAnswer) covered.push(behavior.label)
    else if (behavior.core) missingCore.push(behavior.label)
    else gaps.push(behavior.label)
  }
  const review = wanted
    ? target
        .filter((block) => FOREIGN_SYNTAX[wanted]?.test(block.code))
        .map((block) => `A \`${block.language}\` block contains another language's syntax.`)
    : []
  const hasCode = runnable.length > 0
  const verdict: CodeExampleGrade['verdict'] = configErrors.length
    ? 'invalid'
    : !hasCode || languageOk === false || missingCore.length
      ? 'fail'
      : review.length
        ? 'review'
        : 'pass'
  return {
    hasCode,
    languages,
    languageOk,
    covered,
    missingCore,
    gaps,
    keywordCoverage,
    ...(configErrors.length ? { configErrors } : {}),
    ...(review.length ? { review } : {}),
    verdict,
    method: 'keyword-heuristic'
  }
}
