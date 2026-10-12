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

/** Public hostname:port Eris clients use (plain HTTP — terminate TLS at a proxy in production). */
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
  host: process.env.ERIS_CLOUD_HOST || '0.0.0.0',
  port: Number(process.env.ERIS_CLOUD_PORT || 6443),
  publicBaseUrl: (process.env.ERIS_CLOUD_PUBLIC_URL || PUBLIC_BASE_URL).replace(/\/+$/, ''),
  dataDir: process.env.ERIS_CLOUD_DATA || '/var/lib/eris-cloud',
  maxParallel: Math.max(1, Math.min(8, Number(process.env.ERIS_CLOUD_MAX_PARALLEL || 2))),
  maxFiles: Math.max(1, Math.min(800, Number(process.env.ERIS_CLOUD_MAX_FILES || 200))),
  maxFileBytes: Math.max(1024, Number(process.env.ERIS_CLOUD_MAX_FILE_BYTES || 400_000)),
  maxArtifactBytes: Math.max(1_000_000, Number(process.env.ERIS_CLOUD_MAX_ARTIFACT_BYTES || 16_000_000)),
  maxSteps: Math.max(8, Math.min(80, Number(process.env.ERIS_CLOUD_MAX_STEPS || 24))),
  maxQueue: Math.max(10, Math.min(500, Number(process.env.ERIS_CLOUD_MAX_QUEUE || 100))),
  freeJobsPerDay: Math.max(1, Number(process.env.ERIS_CLOUD_FREE_JOBS_PER_DAY || 5)),
  maxConcurrentFree: Math.max(1, Math.min(4, Number(process.env.ERIS_CLOUD_MAX_CONCURRENT_FREE || 1))),
  maxConcurrentPro: Math.max(1, Math.min(8, Number(process.env.ERIS_CLOUD_MAX_CONCURRENT_PRO || 3))),
  erisApiBase:
    process.env.ERIS_CLOUD_ERIS_API_BASE || 'https://www.ericservic.es/api/eris/v1',
  /**
   * When true, unauthenticated requests are allowed (dev only).
   * Default false — require EricServic.es Bearer token.
   */
  allowAnonymous: process.env.ERIS_CLOUD_ALLOW_ANONYMOUS === '1',
  gpu: parseGpuMode(process.env.ERIS_CLOUD_GPU),
  llmBase: (process.env.ERIS_CLOUD_LLM_BASE || '').replace(/\/+$/, ''),
  llmKey: process.env.ERIS_CLOUD_LLM_KEY || '',
  llmModel: process.env.ERIS_CLOUD_LLM_MODEL || 'composer'
}

export function llmConfigured(): boolean {
  return true
}
