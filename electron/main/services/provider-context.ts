import { boundedContextWindow, validContextWindow } from '../../../src/shared/model-context'

/** Facts from a model-list refresh, never guessed from an ID or shared across endpoints. */
const catalogs = new Map<
  string,
  { at: number; models: Map<string, { contextWindow: number; maxOutputTokens?: number }> }
>()
const endpoint = (url: string) => url.replace(/\/$/, '')
const TTL_MS = 5 * 60_000

export function recordProviderContexts(baseUrl: string, rows: unknown[]): void {
  const models = new Map<string, { contextWindow: number; maxOutputTokens?: number }>()
  for (const row of rows.slice(0, 4096)) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const top = item.top_provider as Record<string, unknown> | undefined
    const window =
      item.context_length ?? item.max_model_len ?? item.context_window ?? top?.context_length
    if (typeof item.id !== 'string' || item.id.length > 512 || !validContextWindow(window)) continue
    const output = item.max_output_tokens ?? top?.max_completion_tokens
    models.set(item.id, {
      contextWindow: boundedContextWindow(window),
      ...(typeof output === 'number' &&
      Number.isSafeInteger(output) &&
      output >= 128 &&
      output <= window
        ? { maxOutputTokens: output }
        : {})
    })
  }
  const key = endpoint(baseUrl)
  if (catalogs.size >= 32 && !catalogs.has(key)) catalogs.delete(catalogs.keys().next().value!)
  catalogs.set(key, { at: Date.now(), models })
}

export function providerContext(baseUrl: string, model: string) {
  const facts = catalogs.get(endpoint(baseUrl))
  if (!facts || Date.now() - facts.at > TTL_MS) return undefined
  return facts.models.get(model)
}
