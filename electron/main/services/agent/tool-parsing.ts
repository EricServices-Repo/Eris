import type { NativeToolCall } from '../chat-runtime'
import { isToolLogReply } from '../../../../src/shared/posted-answer'
import { isMcpToolName } from '../mcp-runtime'
import { COMPOSER_OPENAI_TOOLS } from '../tool-registry'
import type { ToolCall } from './types'

const TOOL_BLOCK_RE = /<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/gi
const TOOL_XML_RE = /<tool_call>\s*<name>\s*([^<]+?)\s*<\/name>\s*([\s\S]*?)<\/tool_call>/gi

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to balanced extract
  }
  for (const candidate of extractBalancedJsonObjects(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // continue
    }
  }
  return null
}

/** Extract top-level `{...}` objects with string-aware brace matching. */
export function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          out.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return out
}

const KNOWN_TOOLS = new Set(COMPOSER_OPENAI_TOOLS.map((tool) => tool.function.name))

// Accept ```json or broken ``json fences (Lite often emits only two backticks)
const FENCE_JSON_RE = /`{2,3}(?:json|tool)?\s*([\s\S]*?)`{2,3}/gi

function toolCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}|${Object.entries(args)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${JSON.stringify(value)}`)
    .join('|')}`
}

function pushToolCall(
  calls: ToolCall[],
  seen: Set<string>,
  toolName: string,
  args: Record<string, unknown>,
  raw: string
): void {
  const name = toolName.trim()
  if (!KNOWN_TOOLS.has(name) && !isMcpToolName(name)) return
  const key = toolCallKey(name, args)
  if (seen.has(key)) return
  seen.add(key)
  calls.push({ name, args, raw })
}

function pushToolEnvelope(
  calls: ToolCall[],
  seen: Set<string>,
  envelope: Record<string, unknown> | null,
  raw: string
): void {
  if (!envelope || typeof envelope.name !== 'string') return
  const nested = envelope.arguments
  const args =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'name'))
  pushToolCall(calls, seen, envelope.name, args, raw)
}

/** "I'll run…", "Next, I will…", "Let me…": the model announcing its next action. */
const NEXT_ACTION_INTENT = /\b(?:I(?:'ll|’ll| will| am going to|'m going to|’m going to)|let me|next,? I|now I|going to)\b/i
const NARRATION_MAX_CHARS = 400

/**
 * Prose that announces an action, followed by exactly one fenced tool envelope for
 * a known tool and nothing after it: "Next, I will run a cat command to verify:
 * ```json {"name":"run",…}```" (#506). That fence is a tool call, not an example.
 * A fence without an intent phrase, a second fence, or prose after the fence is
 * still treated as an example, as before.
 */
function narratedToolFence(text: string): { block: string; body: string } | null {
  FENCE_JSON_RE.lastIndex = 0
  const fences = [...text.matchAll(FENCE_JSON_RE)]
  FENCE_JSON_RE.lastIndex = 0
  if (fences.length !== 1) return null
  const fence = fences[0]!
  const start = fence.index ?? 0
  const before = text.slice(0, start).trim()
  const after = text.slice(start + fence[0].length).trim()
  if (!before || after || before.length > NARRATION_MAX_CHARS) return null
  if (!NEXT_ACTION_INTENT.test(before)) return null
  const body = fence[1] ?? ''
  return isToolEnvelopeBody(body) ? { block: fence[0], body } : null
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null

  TOOL_BLOCK_RE.lastIndex = 0
  while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
    pushToolEnvelope(calls, seen, parseJsonObject(m[1]), m[0])
  }

  FENCE_JSON_RE.lastIndex = 0
  const fencedOnly = text.replace(FENCE_JSON_RE, '').trim().length === 0
  FENCE_JSON_RE.lastIndex = 0
  while (fencedOnly && (m = FENCE_JSON_RE.exec(text)) !== null) {
    pushToolEnvelope(calls, seen, parseJsonObject(m[1]), m[0])
  }
  if (!fencedOnly) {
    const narrated = narratedToolFence(text)
    if (narrated) pushToolEnvelope(calls, seen, parseJsonObject(narrated.body), narrated.block)
  }

  TOOL_XML_RE.lastIndex = 0
  while ((m = TOOL_XML_RE.exec(text)) !== null) {
    const name = m[1].trim()
    const body = m[2]
    const args: Record<string, unknown> = {}
    const pathMatch = body.match(/<path>\s*([\s\S]*?)\s*<\/path>/i)
    const contentMatch = body.match(/<content>\s*([\s\S]*?)\s*<\/content>/i)
    const toMatch = body.match(/<to>\s*([\s\S]*?)\s*<\/to>/i)
    if (pathMatch) args.path = pathMatch[1]
    if (contentMatch) args.content = contentMatch[1]
    if (toMatch) args.to = toMatch[1]
    pushToolCall(calls, seen, name, args, m[0])
  }

  // Bare / unfenced JSON objects (including incomplete fences that still have a full object)
  const bare = extractBalancedJsonObjects(text)
  const residue = bare
    .reduce((value, raw) => value.replace(raw, ''), text)
    .replace(/[\s,;[\]]/g, '')
  if (!residue) for (const raw of bare) pushToolEnvelope(calls, seen, parseJsonObject(raw), raw)

  return calls
}

/** Prose the user should read. Tool JSON and status lines stay in Thinking. */
export function proseOutsideTools(text: string): string {
  let rest = stripToolBlocks(text)
  // A bare object is protocol only when the reply is nothing but tool envelopes,
  // exactly when parseToolCalls would execute it. {"name":"Alice"} is an answer.
  const bare = extractBalancedJsonObjects(rest)
  const onlyObjects = !bare
    .reduce((value, raw) => value.replace(raw, ''), rest)
    .replace(/[\s,;[\]]/g, '')
  if (onlyObjects)
    for (const raw of bare) if (isToolEnvelopeBody(raw)) rest = rest.replace(raw, '')
  return rest
    .split('\n')
    .filter((line) => !/^\s*—/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Prefer the model's full reply over an action-log fallback. */
export function postedAnswer(modelText: string, fallback: string): string {
  const prose = proseOutsideTools(modelText)
  if (prose.length >= 40 && !isToolLogReply(prose)) return prose
  if (fallback.trim() && !isToolLogReply(fallback)) return fallback
  return prose.length >= 40 ? prose : fallback
}

/** Text the user can see. Tool JSON stays out of the thinking log. */
export function thinkingBeforeTools(text: string): string {
  const start = text.search(/<<<TOOL>>>|<tool_call>|\{\s*"name"\s*:\s*"/)
  return (start === -1 ? text : text.slice(0, start)).replace(/\s+$/, '')
}

/** True when at least one complete tool call is available to execute now. */
export function hasExecutableToolCall(text: string): boolean {
  return parseToolCalls(text).length > 0
}

/**
 * A tool-call envelope for a tool this runtime knows: {"name":"read_file", …}.
 * A string `name` alone is ordinary data — package manifests and user records have one.
 */
function isToolEnvelopeBody(body: string): boolean {
  const parsed = parseJsonObject(body)
  if (!parsed || typeof parsed.name !== 'string') return false
  const name = parsed.name.trim()
  return KNOWN_TOOLS.has(name) || isMcpToolName(name)
}

export function stripToolBlocks(text: string): string {
  // Fenced envelopes are protocol only when the reply is nothing but fences, the
  // same rule parseToolCalls uses to execute them. Otherwise a fence documenting a
  // tool call, or any ```json example, is part of the answer.
  FENCE_JSON_RE.lastIndex = 0
  const fencedOnly = text.replace(FENCE_JSON_RE, '').trim().length === 0
  FENCE_JSON_RE.lastIndex = 0
  // A narrated tool fence is executed by parseToolCalls, so it is protocol too (#506).
  const narrated = fencedOnly ? null : narratedToolFence(text)
  return (narrated ? text.replace(narrated.block, '') : text)
    .replace(TOOL_BLOCK_RE, '')
    .replace(FENCE_JSON_RE, (block, body: string) =>
      fencedOnly && isToolEnvelopeBody(body) ? '' : block
    )
    .replace(TOOL_XML_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Two spellings of one argument that disagree, which neither can be chosen over the other. */
export function conflictingAliases(
  args: Record<string, unknown>,
  pairs: ReadonlyArray<readonly [string, string]>
): string | null {
  for (const [first, second] of pairs) {
    if (args[first] === undefined || args[second] === undefined) continue
    if (JSON.stringify(args[first]) !== JSON.stringify(args[second]))
      return `${first} and ${second} disagree. Send one of them.`
  }
  return null
}

export function argString(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : fallback
}

export function nativeToToolCalls(calls: NativeToolCall[]): ToolCall[] {
  return calls.map((call) => {
    let args: Record<string, unknown> = {}
    let parseError: string | undefined
    try {
      const parsed = JSON.parse(call.arguments || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Arguments must be an object')
      args = parsed
    } catch {
      parseError = 'Malformed native tool arguments; return a valid JSON object.'
    }
    return { id: call.id, name: call.name, args, raw: call.arguments, parseError }
  })
}
