/**
 * Hugging Face Hub helpers for discovering GGUF models to run inside Eris.
 * Browse UI: https://huggingface.co/models?library=gguf
 */
import { downloadFetch, formatDownloadNetworkError } from './http-download'

export const HF_GGUF_BROWSE_URL =
  'https://huggingface.co/models?library=gguf&sort=downloads'

export type HfGgufSearchHit = {
  repoId: string
  url: string
  downloads: number
  likes: number
  /** Best-effort short label from the repo id */
  name: string
}

export type HfGgufFile = {
  repoId: string
  filename: string
  downloadUrl: string
  sizeBytes: number
  quant: string
}

type HfModelListItem = {
  id?: string
  modelId?: string
  downloads?: number
  likes?: number
}

type HfTreeEntry = {
  type?: string
  path?: string
  size?: number
}

const QUANT_PREFERENCE = [
  'Q4_K_M',
  'Q4_K_S',
  'Q5_K_M',
  'Q4_0',
  'IQ4_XS',
  'Q5_0',
  'Q3_K_M',
  'Q6_K',
  'Q8_0'
]

function shortName(repoId: string): string {
  const leaf = repoId.split('/').pop() || repoId
  return leaf.replace(/-?GGUF$/i, '').replace(/_/g, ' ')
}

/** Pull owner/repo from a Hub model URL or accept a bare repo id. */
export function normalizeHfRepoId(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  const fromUrl = s.match(
    /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?(?:\?.*)?(?:#.*)?$/i
  )
  if (fromUrl) return fromUrl[1]
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s
  return null
}

/** Direct resolve URL for a single GGUF file on the Hub. */
export function parseHfGgufFileUrl(input: string): {
  repoId: string
  filename: string
  downloadUrl: string
} | null {
  const s = input.trim()
  const m = s.match(
    /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:resolve|blob)\/[^/]+\/(.+\.gguf)(?:\?.*)?$/i
  )
  if (!m) return null
  const repoId = m[1]
  const filename = decodeURIComponent(m[2].split('/').pop() || m[2])
  return {
    repoId,
    filename,
    downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${filename}`
  }
}

function pickQuantLabel(filename: string): string {
  const upper = filename.toUpperCase()
  for (const q of QUANT_PREFERENCE) {
    if (upper.includes(q)) return q
  }
  const m = filename.match(/[-_](Q\d[_A-Z0-9]+|IQ\d[_A-Z0-9]+)\.gguf$/i)
  return m ? m[1].toUpperCase() : 'GGUF'
}

function scoreGgufFile(path: string): number {
  const base = path.split('/').pop() || path
  if (!/\.gguf$/i.test(base)) return -1
  if (/mmproj|encoder|vision|embed/i.test(base)) return -1
  if (/fp16/i.test(base)) return -1
  const upper = base.toUpperCase()
  const idx = QUANT_PREFERENCE.findIndex((q) => upper.includes(q))
  if (idx >= 0) return 1000 - idx
  if (/Q4|IQ4/i.test(base)) return 100
  if (/Q5/i.test(base)) return 80
  if (/Q3/i.test(base)) return 60
  if (/Q6|Q8/i.test(base)) return 40
  return 10
}

async function hfJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res
  try {
    res = await downloadFetch(url, {
      signal,
      headers: { Accept: 'application/json' }
    })
  } catch (err) {
    if (err instanceof Error && /Could not reach|offline/i.test(err.message)) throw err
    throw formatDownloadNetworkError(err, url)
  }
  if (!res.ok || !res.body) {
    throw new Error(`Hugging Face API failed: HTTP ${res.status}`)
  }
  const text = await new Response(res.body).text()
  return JSON.parse(text) as T
}

/**
 * Search Hub model repos tagged GGUF by name (and accept pasted repo URLs).
 */
export async function searchHfGgufModels(
  query: string,
  options?: { limit?: number; signal?: AbortSignal }
): Promise<HfGgufSearchHit[]> {
  const limit = Math.min(40, Math.max(1, options?.limit ?? 20))
  const q = query.trim()
  if (!q) return []

  const directRepo = normalizeHfRepoId(q)
  const search = encodeURIComponent(directRepo || q)
  const url =
    `https://huggingface.co/api/models?search=${search}` +
    `&filter=gguf&sort=downloads&direction=-1&limit=${limit}`

  const list = await hfJson<HfModelListItem[]>(url, options?.signal)
  const hits: HfGgufSearchHit[] = []
  const seen = new Set<string>()

  if (directRepo) {
    hits.push({
      repoId: directRepo,
      url: `https://huggingface.co/${directRepo}`,
      downloads: 0,
      likes: 0,
      name: shortName(directRepo)
    })
    seen.add(directRepo.toLowerCase())
  }

  for (const item of list) {
    const repoId = (item.id || item.modelId || '').trim()
    if (!repoId || seen.has(repoId.toLowerCase())) continue
    seen.add(repoId.toLowerCase())
    hits.push({
      repoId,
      url: `https://huggingface.co/${repoId}`,
      downloads: Number(item.downloads) || 0,
      likes: Number(item.likes) || 0,
      name: shortName(repoId)
    })
  }
  return hits
}

/** Choose a desktop-friendly GGUF file (prefers Q4_K_M) from a Hub repo. */
export async function resolveHfGgufFile(
  repoIdOrUrl: string,
  options?: { signal?: AbortSignal; filename?: string }
): Promise<HfGgufFile> {
  const parsedFile = parseHfGgufFileUrl(repoIdOrUrl)
  if (parsedFile) {
    return {
      repoId: parsedFile.repoId,
      filename: parsedFile.filename,
      downloadUrl: parsedFile.downloadUrl,
      sizeBytes: 0,
      quant: pickQuantLabel(parsedFile.filename)
    }
  }

  const repoId = normalizeHfRepoId(repoIdOrUrl)
  if (!repoId) throw new Error('Expected a Hugging Face repo id or model URL')

  const tree = await hfJson<HfTreeEntry[]>(
    `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`,
    options?.signal
  )

  const files = tree.filter((e) => e.type === 'file' && typeof e.path === 'string')
  if (options?.filename) {
    const want = options.filename
    const hit = files.find((e) => e.path === want || e.path?.endsWith(`/${want}`))
    if (!hit?.path) throw new Error(`File not found in ${repoId}: ${want}`)
    const filename = hit.path.split('/').pop() || hit.path
    return {
      repoId,
      filename,
      downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${hit.path}`,
      sizeBytes: Number(hit.size) || 0,
      quant: pickQuantLabel(filename)
    }
  }

  let best: HfTreeEntry | null = null
  let bestScore = -1
  for (const f of files) {
    const score = scoreGgufFile(f.path || '')
    if (score > bestScore) {
      bestScore = score
      best = f
    }
  }
  if (!best?.path || bestScore < 0) {
    throw new Error(`No suitable .gguf file found in ${repoId}`)
  }
  const filename = best.path.split('/').pop() || best.path
  return {
    repoId,
    filename,
    downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${best.path}`,
    sizeBytes: Number(best.size) || 0,
    quant: pickQuantLabel(filename)
  }
}
