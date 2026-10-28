/**
 * Deterministic checks over a final answer. They say whether the deliverable is
 * visibly broken (protocol framing, truncated code, a refusal), never whether it
 * is correct: a pass here is not an answer-quality grade.
 */
export const DELIVERABLE_CHECKS_VERSION = '2026-10-26.1'

export type DeliverableCheckId =
  | 'empty-answer'
  | 'protocol-leak'
  | 'tool-call-as-answer'
  | 'tool-schema-discussion'
  | 'unclosed-code-fence'
  | 'unfinished-code'
  | 'refusal'
  | 'clarification-request'

export interface DeliverableCheck {
  id: DeliverableCheckId
  /** fail: the deliverable is visibly broken. review: a candidate needing adjudication. */
  severity: 'fail' | 'review'
  detail: string
}

export interface DeliverableAssessment {
  status: 'pass' | 'fail' | 'needs-review'
  version: string
  checks: DeliverableCheck[]
}

export interface DeliverableContext {
  allowToolJson?: boolean
  /** Derived only from the trusted request, never from model prose. */
  protocolExamples?: boolean
  artifact?: string
  language?: string | null
  termination?: string
}
export function deliverableContext(
  goal: string,
  artifact?: string,
  language?: string | null
): DeliverableContext {
  return {
    artifact,
    language,
    allowToolJson: /\b(?:json|tool call)\b/i.test(goal),
    protocolExamples:
      /\b(?:explain|document|example|show|describe|test)\b/i.test(goal) &&
      /\b(?:protocol|tool|USER:|ASSISTANT:|TOOL_RESULT)\b/i.test(goal)
  }
}
/** Preserve offsets while masking Markdown quotation/example regions. */
function unquoted(text: string): string {
  let fence = '',
    count = 0
  return text
    .split('\n')
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      const quoted = Boolean(fence) || /^\s*>/.test(line) || Boolean(marker)
      if (marker) {
        if (!fence) {
          fence = marker[1][0]
          count = marker[1].length
        } else if (marker[1][0] === fence && marker[1].length >= count) fence = ''
      }
      return quoted
        ? ' '.repeat(line.length)
        : line.replace(/(`+)(.*?)\1/g, (m) => ' '.repeat(m.length))
    })
    .join('\n')
}
/** Runtime framing that belongs to the transport or tool protocol, never to an answer. */
const PROTOCOL_FRAMING =
  /<<<(?:END|TOOL|TOOL_RESULT|END_TOOL_RESULT)\b[^>]*>>>|^\s*TOOL_RESULT\s+\w+:|\bNOT_EXECUTED\b|\[Eris recovery\]|^\s*(?:USER|ASSISTANT|SYSTEM):\s*$/m
/** A bare tool envelope with a runtime tool name. */
const TOOL_ENVELOPE =
  /^\s*\{\s*"name"\s*:\s*"(?:read_file|write_file|retrieve|tree|list_dir|run|search_replace|apply_patch|mkdir|delete_path|rename_path|grep|web_search|web_fetch|verify|delegate)"/m
/** Explaining the agent's own tool arguments instead of the task. */
const TOOL_SCHEMA_TALK =
  /\b(?:the\s+)?`?(?:retrieve|read_file|list_dir|tree)`?\s+tool(?:\s+call)?\b[^\n]{0,160}\b(?:arguments?|parameters?|schema|field)\b|\btool call has invalid arguments\b/i
const REFUSAL =
  /^\s*(?:i['’]m sorry|i am sorry|sorry|i apologi[sz]e|unfortunately,?\s+i\s+(?:can['’]?t|cannot))\b/i
const CLARIFY =
  /\b(?:could|can|would)\s+you\s+(?:please\s+)?(?:provide|share|clarify|give|tell)\b|\bmore (?:information|context|details)\b/i

/** An odd number of ``` markers leaves the last block open; its body follows the language tag. */
function fenceState(text: string): { open: boolean; trailing: string; language: string } {
  let fence = '',
    count = 0,
    language = ''
  const body: string[] = []
  for (const line of text.split('\n')) {
    const marker =
      /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line) ??
      (!fence ? /(?:^|\s)(`{3,}|~{3,})([A-Za-z][\w+-]*)\s*$/.exec(line) : null)
    if (!fence && marker) {
      fence = marker[1][0]
      count = marker[1].length
      language = marker[2].trim().toLowerCase()
      body.length = 0
      continue
    }
    if (
      fence &&
      marker &&
      marker[1][0] === fence &&
      marker[1].length >= count &&
      !marker[2].trim()
    ) {
      fence = ''
      body.length = 0
      continue
    }
    if (fence) body.push(line)
  }
  return { open: Boolean(fence), trailing: body.join('\n'), language }
}

/** More openers than closers at the end of a code block: the program stopped mid-construct. */
function unbalanced(code: string, language: string): boolean {
  // Lexical hint only, never a syntax or semantic verdict. Mask string/comment
  // delimiters so a literal "{" cannot trigger a repair.
  const masked = (
    language === 'python' || language === 'py' ? code.replace(/#[^\n]*/g, '') : code
  ).replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    ''
  )
  const count = (pattern: RegExp) => (masked.match(pattern) ?? []).length
  return count(/\{/g) > count(/\}/g) || count(/\(/g) > count(/\)/g) || count(/\[/g) > count(/\]/g)
}

export function assessDeliverable(
  response: string | null | undefined,
  options: DeliverableContext = {}
): DeliverableAssessment {
  const text = response ?? ''
  const checks: DeliverableCheck[] = []
  if (!text.trim()) {
    checks.push({ id: 'empty-answer', severity: 'fail', detail: 'No answer text was produced.' })
  } else {
    const exposed = unquoted(text)
    if (PROTOCOL_FRAMING.test(text))
      checks.push({
        id: 'protocol-leak',
        severity:
          PROTOCOL_FRAMING.test(exposed) &&
          !(options.protocolExamples && !/<<<|TOOL_RESULT|NOT_EXECUTED/.test(exposed))
            ? 'fail'
            : 'review',
        detail: 'Transport or tool-protocol framing appears in the answer.'
      })
    if (!options.allowToolJson && TOOL_ENVELOPE.test(text))
      checks.push({
        id: 'tool-call-as-answer',
        severity: TOOL_ENVELOPE.test(exposed) ? 'fail' : 'review',
        detail: 'A runtime tool call was returned as answer text.'
      })
    if (TOOL_SCHEMA_TALK.test(text))
      checks.push({
        id: 'tool-schema-discussion',
        severity: 'review',
        detail: 'The answer discusses the agent’s own tool arguments.'
      })
    if (options.protocolExamples) {
      for (let i = checks.length - 1; i >= 0; i--)
        if (
          checks[i].severity === 'review' &&
          ['protocol-leak', 'tool-call-as-answer', 'tool-schema-discussion'].includes(checks[i].id)
        )
          checks.splice(i, 1)
    }
    const fences = fenceState(text)
    if (fences.open) {
      const code = fences.trailing.trim()
      if (!code || unbalanced(code, fences.language))
        checks.push({
          id: 'unfinished-code',
          severity: !code || options.termination === 'output-limit' ? 'fail' : 'review',
          detail: code
            ? 'The final code block stops inside an unfinished construct.'
            : 'The answer ends at an opening code fence with no code.'
        })
      else
        checks.push({
          id: 'unclosed-code-fence',
          severity: 'review',
          detail: 'The final code fence is never closed.'
        })
    }
    if (REFUSAL.test(text))
      checks.push(
        CLARIFY.test(text)
          ? {
              id: 'clarification-request',
              severity: 'review',
              detail: 'The answer asks for more context instead of answering.'
            }
          : { id: 'refusal', severity: 'review', detail: 'The answer declines the request.' }
      )
  }
  return {
    status: checks.some((check) => check.severity === 'fail')
      ? 'fail'
      : checks.length
        ? 'needs-review'
        : 'pass',
    version: DELIVERABLE_CHECKS_VERSION,
    checks
  }
}

/**
 * Remove transport framing that a native template or recovery prompt let through:
 * everything from the first protocol marker onward, when real content precedes it.
 * Returns null when nothing usable precedes the leak.
 */
export function stripProtocolTail(text: string): string | null {
  const marker = unquoted(text).search(
    /<<<(?:END|TOOL|TOOL_RESULT)\b[^>]*>>>|^\s*(?:USER|ASSISTANT|SYSTEM):\s*$|^\s*TOOL_RESULT\s+\w+:/m
  )
  if (marker < 0) return text
  const head = text.slice(0, marker).trim()
  return head && !TOOL_ENVELOPE.test(head) ? head : null
}
