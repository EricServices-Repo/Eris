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

/** Public hostname:port Eris clients use (no user config). */
export const PUBLIC_BASE_URL = 'https://agents.ericservic.es:6443'

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
   * Optional override: OpenAI-compatible remote API.
   * When unset (default), the Cloud Agent runs its own local GGUF via node-llama-cpp.
   */
  llmBase: (process.env.ERIS_CLOUD_LLM_BASE || '').replace(/\/+$/, ''),
  llmKey: process.env.ERIS_CLOUD_LLM_KEY || '',
  llmModel: process.env.ERIS_CLOUD_LLM_MODEL || 'composer-lite',
  allowAnonymous: process.env.ERIS_CLOUD_ALLOW_ANONYMOUS !== '0'
}

/** True when jobs can be accepted (local model path or remote override). */
export function llmConfigured(): boolean {
  // Local model is always the default — configured even while downloading.
  return true
}
