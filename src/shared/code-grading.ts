import type { TopicRubric } from './topic-rubrics'

/**
 * Deterministic grading of a code-example answer: a fenced code block exists, it
 * is in the requested language, and it covers the rubric's core behaviors. This
 * is a review heuristic over the text; it does not compile or run the code.
 */
export interface CodeExampleGrade {
  hasCode: boolean
  /** Fence tags found, lowercased. */
  languages: string[]
  languageOk: boolean | null
  covered: string[]
  /** Core behaviors not shown. Any entry fails the example. */
  missingCore: string[]
  /** Non-core behaviors not shown; reported as gaps. */
  gaps: string[]
  verdict: 'pass' | 'fail'
  method: 'keyword-heuristic'
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
  options: { language?: string | null; rubric?: TopicRubric; behaviors?: string[] } = {}
): CodeExampleGrade {
  const blocks = codeBlocks(answer)
  const code = blocks.map((block) => block.code).join('\n')
  const wanted = options.language?.toLowerCase()
  const accepted = wanted ? (ALIASES[wanted] ?? [wanted]) : []
  const languages = [...new Set(blocks.map((block) => block.language).filter(Boolean))]
  const languageOk = wanted
    ? blocks.some((block) => accepted.includes(block.language))
    : null
  const behaviors = (options.rubric?.behaviors ?? []).filter(
    (behavior) => !options.behaviors || options.behaviors.includes(behavior.label)
  )
  // Behaviors may be shown in the code or explained beside it; restore logic in prose
  // alone does not count, so core behaviors must appear in the code.
  const covered: string[] = []
  const missingCore: string[] = []
  const gaps: string[] = []
  for (const behavior of behaviors) {
    const inCode = behavior.pattern.test(code)
    const inAnswer = inCode || behavior.pattern.test(answer)
    if (behavior.core ? inCode : inAnswer) covered.push(behavior.label)
    else if (behavior.core) missingCore.push(behavior.label)
    else gaps.push(behavior.label)
  }
  const hasCode = blocks.some((block) => block.code.trim().length > 0)
  return {
    hasCode,
    languages,
    languageOk,
    covered,
    missingCore,
    gaps,
    verdict: hasCode && languageOk !== false && missingCore.length === 0 ? 'pass' : 'fail',
    method: 'keyword-heuristic'
  }
}
