/**
 * Ollama model management — pull/list/delete local models from inside Eris so
 * users can run more local models without a terminal. Talks to Ollama's native
 * REST API (http://host:11434/api/*); chat still routes through its
 * OpenAI-compatible /v1 endpoint via the existing connection.
 */
import type { OllamaLibraryEntry, OllamaPullProgress } from '../../../src/shared/ollama-types'
export type { OllamaLibraryEntry, OllamaPullProgress }

/**
 * Curated slice of ollama.com/library for coding / agent use.
 * Users can also paste any `ollama pull` name or library URL in the UI.
 */
export const OLLAMA_LIBRARY: OllamaLibraryEntry[] = [
  {
    name: 'qwen3.8',
    label: 'Qwen3.8',
    size: '~18 GB',
    description:
      'Latest Qwen3.8 (27B) — strong coding, agent tasks, and long context. ollama.com/library/qwen3.8',
    family: 'Qwen3.8'
  },
  {
    name: 'qwen3.5:9b',
    label: 'Qwen3.5 9B',
    size: '~6 GB',
    description: 'Multimodal Qwen 3.5 mid-size — solid local agent / coding balance.',
    family: 'Qwen3.5'
  },
  {
    name: 'qwen3.5:4b',
    label: 'Qwen3.5 4B',
    size: '~2.5 GB',
    description: 'Smaller Qwen 3.5 — faster on modest machines.',
    family: 'Qwen3.5'
  },
  {
    name: 'qwen3:8b',
    label: 'Qwen3 8B',
    size: '~5.2 GB',
    description: 'Qwen3 dense 8B — strong general + coding, good tool use.',
    family: 'Qwen3'
  },
  {
    name: 'qwen3:4b',
    label: 'Qwen3 4B',
    size: '~2.6 GB',
    description: 'Smaller Qwen3 — fast local chat and edits.',
    family: 'Qwen3'
  },
  {
    name: 'qwen3:14b',
    label: 'Qwen3 14B',
    size: '~9 GB',
    description: 'Larger Qwen3 dense — stronger reasoning when you have the RAM/VRAM.',
    family: 'Qwen3'
  },
  {
    name: 'qwen2.5-coder:7b',
    label: 'Qwen2.5 Coder 7B',
    size: '~4.7 GB',
    description: 'Code-specialized 7B — solid local Composer-class agent model.',
    family: 'Qwen2.5-Coder'
  },
  {
    name: 'qwen2.5-coder:14b',
    label: 'Qwen2.5 Coder 14B',
    size: '~9 GB',
    description: 'Larger coder model for harder refactors and multi-file work.',
    family: 'Qwen2.5-Coder'
  },
  {
    name: 'qwen2.5-coder:3b',
    label: 'Qwen2.5 Coder 3B',
    size: '~1.9 GB',
    description: 'Lighter coder model for quick completions and small edits.',
    family: 'Qwen2.5-Coder'
  },
  {
    name: 'deepseek-r1:8b',
    label: 'DeepSeek-R1 8B',
    size: '~5.2 GB',
    description: 'Reasoning-tuned model — good for planning-heavy tasks.',
    family: 'DeepSeek'
  },
  {
    name: 'deepseek-r1:14b',
    label: 'DeepSeek-R1 14B',
    size: '~9 GB',
    description: 'Larger DeepSeek-R1 distill — stronger reasoning locally.',
    family: 'DeepSeek'
  },
  {
    name: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    size: '~4.7 GB',
    description: 'Meta Llama 3.1 8B — reliable general local model with tools.',
    family: 'Llama'
  },
  {
    name: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    size: '~2.0 GB',
    description: 'Compact general model from Meta — handy lightweight fallback.',
    family: 'Llama'
  },
  {
    name: 'gemma3:4b',
    label: 'Gemma 3 4B',
    size: '~3.3 GB',
    description: "Google's efficient small model for local chat.",
    family: 'Gemma'
  },
  {
    name: 'gemma3:12b',
    label: 'Gemma 3 12B',
    size: '~8 GB',
    description: 'Mid-size Gemma 3 — stronger quality when hardware allows.',
    family: 'Gemma'
  },
  {
    name: 'mistral:7b',
    label: 'Mistral 7B',
    size: '~4.1 GB',
    description: 'Classic Mistral 7B — fast general local chat.',
    family: 'Mistral'
  },
  {
    name: 'gpt-oss:20b',
    label: 'GPT-OSS 20B',
    size: '~12 GB',
    description: "OpenAI open-weight 20B — reasoning / agent-oriented local model.",
    family: 'GPT-OSS'
  },
  {
    name: 'phi4',
    label: 'Phi-4',
    size: '~9 GB',
    description: 'Microsoft Phi-4 — compact but capable reasoning model.',
    family: 'Phi'
  },
  {
    name: 'codellama:7b',
    label: 'Code Llama 7B',
    size: '~3.8 GB',
    description: 'Meta Code Llama — classic local coding model.',
    family: 'Code Llama'
  },
  {
    name: 'starcoder2:7b',
    label: 'StarCoder2 7B',
    size: '~4 GB',
    description: 'Code-focused StarCoder2 for completions and edits.',
    family: 'StarCoder'
  }
]

/**
 * Normalize a typed model ref: trim, strip ollama.com/library URLs, drop junk.
 * Examples: "https://ollama.com/library/qwen3.8" → "qwen3.8"
 */
export function normalizeOllamaModelRef(input: string): string {
  let s = String(input || '').trim()
  if (!s) return ''
  const fromUrl = s.match(/ollama\.com\/library\/([A-Za-z0-9._:-]+)/i)
  if (fromUrl) {
    s = fromUrl[1]!
  } else {
    // Common paste: "ollama pull qwen3.8" or "ollama run qwen3.8"
    const fromCmd = s.match(/^(?:ollama\s+(?:pull|run)\s+)(.+)$/i)
    if (fromCmd) s = fromCmd[1]!.trim()
  }
  s = s.split(/[?#]/)[0] || ''
  s = s.trim().replace(/^\/+|\/+$/g, '')
  // Drop accidental trailing path segments / whitespace tokens
  s = s.split(/\s+/)[0] || ''
  return s
}

/** Whether an installed tag matches a library / pull name (handles :latest). */
export function isOllamaModelInstalled(name: string, installed: string[]): boolean {
  const n = normalizeOllamaModelRef(name)
  if (!n || installed.length === 0) return false
  if (installed.includes(n)) return true
  if (!n.includes(':')) {
    return installed.some((m) => m === `${n}:latest` || m.startsWith(`${n}:`))
  }
  const [base, tag] = n.split(':')
  if (tag === 'latest') {
    return installed.includes(base!) || installed.includes(n)
  }
  return false
}

/** Prefer the concrete installed tag after a pull (e.g. qwen3.8 → qwen3.8:latest). */
export function resolveInstalledOllamaName(requested: string, installed: string[]): string {
  const n = normalizeOllamaModelRef(requested)
  if (!n) return requested
  if (installed.includes(n)) return n
  if (!n.includes(':')) {
    const latest = installed.find((m) => m === `${n}:latest`)
    if (latest) return latest
    const any = installed.find((m) => m.startsWith(`${n}:`))
    if (any) return any
  }
  return n
}

/** Turn an OpenAI-compatible base URL (…/v1) into the native API root. */
export function ollamaNativeHost(baseUrl: string | undefined | null): string {
  const raw = (baseUrl || 'http://127.0.0.1:11434/v1').trim().replace(/\/+$/, '')
  return raw.replace(/\/v1$/, '') || 'http://127.0.0.1:11434'
}

export async function listOllamaInstalled(baseUrl?: string): Promise<string[]> {
  const host = ollamaNativeHost(baseUrl)
  const res = await fetch(`${host}/api/tags`, { method: 'GET' })
  if (!res.ok) throw new Error(`Ollama /api/tags failed (${res.status})`)
  const data = (await res.json()) as { models?: Array<{ name?: string }> }
  return (data.models ?? []).map((m) => m.name || '').filter(Boolean)
}

export async function deleteOllamaModel(name: string, baseUrl?: string): Promise<void> {
  const host = ollamaNativeHost(baseUrl)
  const res = await fetch(`${host}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Ollama delete failed (${res.status})`)
  }
}

/**
 * Pull a model, streaming NDJSON progress lines from Ollama's /api/pull.
 * Calls onProgress for each line; resolves when the stream reports success/ends.
 */
export async function pullOllamaModel(
  name: string,
  onProgress: (p: OllamaPullProgress) => void,
  options?: { baseUrl?: string; signal?: AbortSignal }
): Promise<void> {
  const host = ollamaNativeHost(options?.baseUrl)
  const model = normalizeOllamaModelRef(name)
  if (!model) throw new Error('Model name is required')
  const res = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: options?.signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`Ollama pull failed (${res.status}). Is Ollama running? Try: ollama serve`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (obj: { status?: string; completed?: number; total?: number; error?: string }) => {
    if (obj.error) {
      onProgress({ name: model, status: obj.error, done: true, error: obj.error })
      return
    }
    const percent =
      typeof obj.completed === 'number' && typeof obj.total === 'number' && obj.total > 0
        ? Math.min(100, Math.round((obj.completed / obj.total) * 100))
        : undefined
    const done = (obj.status || '').toLowerCase() === 'success'
    onProgress({
      name: model,
      status: obj.status || 'pulling',
      completed: obj.completed,
      total: obj.total,
      percent,
      done
    })
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        emit(JSON.parse(line))
      } catch {
        /* ignore malformed keepalive lines */
      }
    }
  }
  if (buffer.trim()) {
    try {
      emit(JSON.parse(buffer.trim()))
    } catch {
      /* ignore */
    }
  }
}
