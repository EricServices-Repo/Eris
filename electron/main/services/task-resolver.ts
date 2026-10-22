import type { AppSettings, ChatIntent } from '../../../src/shared/settings-schema'
import { streamModelChat } from './chat-runtime'
import {
  asksForRecommendations,
  asksForPlan,
  asksForVerification,
  asksToImplementChanges,
  needsWebLookup
} from '../../../src/shared/agent-contract'

const intents = [
  'answer',
  'explore',
  'review',
  'plan',
  'verify',
  'edit',
  'run',
  'capability'
] as const
/** Resolve meaning independently of worker identity. A failed resolver grants no new effects. */
export async function resolveTaskIntent(input: {
  text: string
  fallback: ChatIntent
  settings: AppSettings
  model: string
  mode: 'ask' | 'agent'
  history?: Array<{ role: string; content: string }>
  signal?: AbortSignal
  getSecret: (key: string) => string | null
}): Promise<ChatIntent> {
  if (input.fallback === 'capability' || needsWebLookup(input.text)) return input.fallback
  if (/^(?:please\s+)?review\b/i.test(input.text) && ['review', 'explore'].includes(input.fallback))
    return input.fallback
  if (
    asksToImplementChanges(input.text) ||
    asksForRecommendations(input.text) ||
    asksForPlan(input.text) ||
    asksForVerification(input.text)
  )
    return input.fallback
  // Explicit imperative commands need no additional inference.
  if (
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:implement|fix|write|build|create|add|refactor)\b/i.test(
      input.text
    )
  )
    return input.fallback
  if (
    /^(?:please\s+)?(?:implement|fix|write|build|create|delete|rename|add|run|execute|improve|refactor)\b/i.test(
      input.text
    )
  )
    return input.fallback
  const abort = new AbortController()
  const cancel = () => abort.abort(input.signal?.reason)
  if (input.signal?.aborted) cancel()
  else input.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => abort.abort(), 10000)
  try {
    let response = ''
    for await (const chunk of streamModelChat({
      settings: input.settings,
      model: input.model,
      temperature: 0,
      signal: abort.signal,
      getSecret: input.getSecret,
      purpose: 'intent',
      builtinJsonSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: [...intents] },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['intent', 'confidence'],
        additionalProperties: false
      },
      messages: [
        {
          role: 'system',
          content:
            'Interpret the latest request, using history only to resolve references. Return JSON {"intent":...,"confidence":0..1}. answer: general question; explore: explain code; review: assess code and recommend; plan: ordered proposed work; verify: check behavior; edit: explicitly requested code changes; run: execute a requested command; capability: Eris models. Questions about approaches and reviews default to read-only intent. Do not select an agent, invent a project, or execute anything.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            history: input.history
              ?.slice(-6)
              .map((message) => ({ role: message.role, content: message.content.slice(0, 1200) })),
            request: input.text
          })
        }
      ]
    }))
      response += chunk
    const result = JSON.parse(response) as { intent?: ChatIntent; confidence?: number }
    if (
      result.intent &&
      intents.includes(result.intent) &&
      typeof result.confidence === 'number' &&
      result.confidence >= 0.8 &&
      result.confidence <= 1
    ) {
      // Ask mode never becomes an execution contract. Ambiguous mutation proposals need explicit wording.
      if (
        ['edit', 'run'].includes(result.intent) &&
        (input.mode === 'ask' ||
          /^\s*(?:how|what|why|can we|could we|should we)\b/i.test(input.text))
      )
        return input.fallback === 'review' ? 'review' : 'explore'
      return result.intent
    }
  } catch {
    if (input.signal?.aborted) {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      throw error
    }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', cancel)
  }
  return input.fallback === 'edit' ? 'plan' : input.fallback === 'run' ? 'explore' : input.fallback
}
