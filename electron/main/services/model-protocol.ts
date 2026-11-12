import { randomUUID } from 'crypto'
import type { ChatRequestMessage, OpenAIToolDef } from './openai-compatible'
import { contextUnits } from '../../../src/shared/token-estimate'

function decodedArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return { invalidArguments: value }
  }
}

export type ModelMessage = Omit<ChatRequestMessage, 'content'> & {
  content: string
  /** Item accounting for a compiled context. Removed before a request is serialized. */
  contextBundle?: import('../../../src/shared/context-memory').ContextBundle
}
export type ModelCapabilities = {
  protocol: 'native-tools' | 'text-tools'
  contextWindow: number
  outputReserve: number
}

/** The serialized exchange is validated before touching a provider. */
export function validateModelTranscript(messages: readonly ModelMessage[]): void {
  const pending = new Set<string>()
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool' && pending.size)
      throw new Error('Incomplete tool exchange before the next conversation message')
    for (const call of message.tool_calls ?? []) {
      if (message.role !== 'assistant' || !call.id || seen.has(call.id))
        throw new Error('Invalid or duplicate assistant tool call ID')
      seen.add(call.id)
      pending.add(call.id)
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id))
        throw new Error('Orphan or duplicate tool result')
    }
  }
  if (pending.size) throw new Error('Model request has unresolved tool calls')
}

/** Local templates receive explicit result envelopes instead of losing tool roles. */
export function compileModelMessages(
  messages: readonly ModelMessage[],
  capabilities: ModelCapabilities
): ChatRequestMessage[] {
  validateModelTranscript(messages)
  return adaptModelMessagesForAccounting(messages, capabilities.protocol)
}

/** Accounting also sees in-flight calls before their results exist. Never dispatch this without validation. */
export function adaptModelMessagesForAccounting(
  messages: readonly ModelMessage[],
  protocol: ModelCapabilities['protocol']
): ChatRequestMessage[] {
  if (protocol === 'native-tools') return messages.map((message) => ({ ...message }))
  return messages.map((message) => {
    if (message.role === 'tool')
      return {
        role: 'user',
        content: `<<<TOOL_RESULT ${message.tool_call_id}>>>\n${message.content}\n<<<END_TOOL_RESULT>>>`
      }
    if (message.tool_calls?.length)
      return {
        role: 'assistant',
        content:
          message.content +
          '\n' +
          message.tool_calls
            .map(
              (call) =>
                `<<<TOOL>>>\n${JSON.stringify({ name: call.function.name, arguments: decodedArguments(call.function.arguments) })}\n<<<END>>>`
            )
            .join('\n')
      }
    return { role: message.role, content: message.content }
  })
}

/** Strip accounting metadata and inject the exact schema envelope sent to text-tool models. */
export function modelPromptMessages(
  messages: readonly ModelMessage[],
  tools: readonly OpenAIToolDef[],
  protocol: ModelCapabilities['protocol']
): ModelMessage[] {
  const wire = messages.map(({ contextBundle: _bundle, ...message }) => ({
    ...message,
    content: message.content ?? ''
  }))
  if (protocol === 'text-tools' && tools.length)
    wire.splice(1, 0, { role: 'system', content: textToolCatalog(tools) })
  return wire
}

type JsonSchema = {
  type?: string | string[]
  enum?: unknown[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  anyOf?: unknown[]
  oneOf?: unknown[]
}

/** A parameter a one-line signature can describe: a scalar, an enum, or a list of scalars. */
const isFlat = (schema: JsonSchema): boolean =>
  !schema.properties &&
  !schema.anyOf &&
  !schema.oneOf &&
  (schema.type !== 'array' || (!!schema.items && isFlat(schema.items) && schema.items.type !== 'array'))

function parameterType(schema: JsonSchema): string {
  if (schema.enum?.length) return schema.enum.map((value) => JSON.stringify(value)).join('|')
  if (schema.type === 'array') return `${parameterType(schema.items ?? {})}[]`
  const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type
  return type && type !== 'string' ? type : ''
}

/**
 * The tool list for a text-tools model. JSON schemas for every tool cost about 7,000
 * characters on an edit turn; a signature per tool says the same in under half (#540):
 *
 *   - read_file(path, start_line?: integer, end_line?: integer) — Read a text file…
 *       start_line: …
 *
 * `?` marks an optional argument and an untyped argument is a string. A tool whose
 * arguments are nested (some MCP tools) keeps its full JSON schema.
 */
export function textToolCatalog(tools: readonly OpenAIToolDef[]): string {
  const lines = tools.map(({ function: fn }) => {
    const schema = (fn.parameters ?? {}) as JsonSchema
    const properties = Object.entries(schema.properties ?? {})
    if (schema.anyOf || schema.oneOf || properties.some(([, param]) => !isFlat(param)))
      return `- ${fn.name} — ${fn.description ?? ''}\n    JSON schema: ${JSON.stringify(schema)}`
    const required = new Set(schema.required ?? [])
    // Required arguments first, so the signature reads in the order a call needs.
    const ordered = [...properties].sort(
      ([a], [b]) => Number(required.has(b)) - Number(required.has(a))
    )
    const signature = ordered
      .map(([name, param]) => {
        const type = parameterType(param)
        return `${name}${required.has(name) ? '' : '?'}${type ? `: ${type}` : ''}`
      })
      .join(', ')
    const notes = ordered
      .filter(([, param]) => param.description)
      .map(([name, param]) => `\n    ${name}: ${param.description}`)
      .join('')
    return `- ${fn.name}(${signature}) — ${fn.description ?? ''}${notes}`
  })
  return (
    'Available tools. Arguments go in the JSON "arguments" object by name; "?" marks an optional argument and an untyped argument is a string.\n' +
    lines.join('\n')
  )
}

export function serializeModelMessage(message: ChatRequestMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
  })
}

/** Conservative wire estimate, including roles, call IDs, JSON escaping and message framing. */
export function estimateModelMessagesTokens(messages: readonly ChatRequestMessage[]): number {
  return Math.ceil(
    messages.reduce((sum, message) => sum + contextUnits(serializeModelMessage(message)) + 16, 0) /
      3
  )
}

/** Pinned system instructions and complete recent exchanges survive budgeting. */
export function budgetModelMessages(
  messages: ModelMessage[],
  maxTokens: number,
  protocol: ModelCapabilities['protocol'] = 'native-tools',
  tokenCount?: (wire: readonly ChatRequestMessage[]) => number
): { messages: ModelMessage[]; estimatedTokens: number } {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0)
    throw new Error('The model context budget must be positive and finite.')
  // Budget the actual adapter representation: text tool envelopes add tokens and
  // native calls include argument strings and IDs. Count schemas separately once.
  const size = (items: ModelMessage[]) =>
    (tokenCount ?? estimateModelMessagesTokens)(
      compileModelMessages(items, { protocol, contextWindow: Infinity, outputReserve: 0 })
    )
  const pinned = messages.filter((message) => message.role === 'system')
  if (size(pinned) >= maxTokens)
    throw new Error(
      'Task instructions exceed model context. Increase the context window or reduce project rules.'
    )
  const result = messages.map((message) => ({ ...message }))
  // Shorten old evidence; do not remove call/result records or original user intent.
  for (let index = 0; index < result.length - 3 && size(result) > maxTokens; index++) {
    const item = result[index]!
    if (item.role === 'tool' && item.content.length > 1000)
      item.content =
        item.content.slice(0, 700) +
        '\n[Evidence shortened; inspect again if needed.]\n' +
        item.content.slice(-200)
  }
  if (size(result) > maxTokens) {
    for (const item of result) {
      if (size(result) <= maxTokens) break
      if (item.role === 'tool' && item.content.length > 600)
        item.content =
          item.content.slice(0, 350) +
          '\n[Evidence excerpt; read a narrower range for details.]\n' +
          item.content.slice(-150)
    }
  }
  const estimatedTokens = size(result)
  if (estimatedTokens > maxTokens)
    throw new Error(
      'Conversation exceeds the model context budget after evidence cleanup. Reduce attached context or use a larger context window.'
    )
  return { messages: result, estimatedTokens }
}

/** Runtime-initiated inspection/checks use the same evidence protocol as model-requested tools. */
export function appendToolObservation(
  messages: ModelMessage[],
  name: string,
  content: string,
  args: Record<string, unknown> = {}
): void {
  const id = `runtime-${randomUUID()}`
  messages.push(
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    },
    { role: 'tool', tool_call_id: id, content }
  )
}
