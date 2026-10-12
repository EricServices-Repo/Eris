import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function pkgVersion(): string {
  try {
    const p = join(__dirname, '..', 'package.json')
    if (existsSync(p)) {
      return (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version || '0.1.0'
    }
  } catch {
    // ignore
  }
  return '0.1.0'
}

/** Public hostname:port Eris clients use (plain HTTP — no TLS cert). */
export const PUBLIC_BASE_URL = 'http://agents.ericservic.es:6443'

/** GPU preference for the in-container GGUF (node-llama-cpp). */
export type GpuMode = 'auto' | 'cuda' | 'vulkan' | 'false'

function parseGpuMode(raw: string | undefined): GpuMode {
  const v = (raw || 'auto').trim().toLowerCase()
  if (v === 'cuda' || v === 'vulkan' || v === 'auto') return v
  if (v === '0' || v === 'false' || v === 'cpu' || v === 'off' || v === 'none') return 'false'
  return 'auto'
}

export const config = {
  version: pkgVersion(),
  /** Listen inside the container / host */
  host: process.env.ERIS_CLOUD_HOST || '0.0.0.0',
  port: Number(process.env.ERIS_CLOUD_PORT || 6443),
  publicBaseUrl: (process.env.ERIS_CLOUD_PUBLIC_URL || PUBLIC_BASE_URL).replace(/\/+$/, ''),
  dataDir: process.env.ERIS_CLOUD_DATA || '/var/lib/eris-cloud',
  maxParallel: Math.max(1, Math.min(8, Number(process.env.ERIS_CLOUD_MAX_PARALLEL || 2))),
  maxFiles: Math.max(1, Math.min(500, Number(process.env.ERIS_CLOUD_MAX_FILES || 120))),
  maxFileBytes: Math.max(1024, Number(process.env.ERIS_CLOUD_MAX_FILE_BYTES || 200_000)),
  /**
   * GPU for local GGUF: auto (prefer CUDA/Vulkan) | cuda | vulkan | false (CPU).
   * Requires NVIDIA Container Toolkit + CUDA libs in the image for GPU.
   */
  gpu: parseGpuMode(process.env.ERIS_CLOUD_GPU),
  /**
   * Optional override: OpenAI-compatible remote API.
   * When unset (default), the Cloud Agent runs its own local GGUF via node-llama-cpp.
   */
  llmBase: (process.env.ERIS_CLOUD_LLM_BASE || '').replace(/\/+$/, ''),
  llmKey: process.env.ERIS_CLOUD_LLM_KEY || '',
  llmModel: process.env.ERIS_CLOUD_LLM_MODEL || 'composer',
  allowAnonymous: process.env.ERIS_CLOUD_ALLOW_ANONYMOUS !== '0'
}

/** True when jobs can be accepted (local model path or remote override). */
export function llmConfigured(): boolean {
  // Local model is always the default — configured even while downloading.
  return true
}
