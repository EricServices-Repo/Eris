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

/** Public URL Eris clients use. TLS terminates at nginx :443; this process stays the HTTP upstream. */
export const PUBLIC_BASE_URL = 'https://agents.ericservic.es:443'

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
  /**
   * Unauthenticated status webpage + JSON.
   * Host maps public :80 → this port (default 8080 inside the container).
   * Set ERIS_CLOUD_STATUS_ENABLED=0 to disable.
   */
  statusPort: Math.max(1, Number(process.env.ERIS_CLOUD_STATUS_PORT || 8080)),
  statusEnabled: process.env.ERIS_CLOUD_STATUS_ENABLED !== '0',
  publicBaseUrl: (process.env.ERIS_CLOUD_PUBLIC_URL || PUBLIC_BASE_URL).replace(/\/+$/, ''),
  dataDir: process.env.ERIS_CLOUD_DATA || '/var/lib/eris-cloud',
  maxParallel: (() => {
    const raw = Number(process.env.ERIS_CLOUD_MAX_PARALLEL || 2)
    const n = Math.max(1, Math.min(8, Number.isFinite(raw) ? raw : 2))
    // CPU hosts: never run more than one job — one context / two threads.
    if (parseGpuMode(process.env.ERIS_CLOUD_GPU) === 'false') return Math.min(1, n)
    return n
  })(),
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
  /**
   * Shared secret for ops force-kill-all (`POST /v1/admin/kill-all` and status page).
   * When empty, admin kill-all is disabled (user `POST /v1/jobs/stop-all` still works).
   */
  adminToken: (process.env.ERIS_CLOUD_ADMIN_TOKEN || '').trim(),
  gpu: parseGpuMode(process.env.ERIS_CLOUD_GPU),
  /**
   * Cap llama.cpp CPU threads. Critical on CPU-only VMs so sshd/systemd stay responsive.
   * Default: 2 on CPU, 0 (unlimited) when a GPU mode is selected.
   */
  maxThreads: (() => {
    const raw = process.env.ERIS_CLOUD_MAX_THREADS
    if (raw != null && String(raw).trim() !== '') {
      return Math.max(0, Math.min(64, Number(raw) || 0))
    }
    return parseGpuMode(process.env.ERIS_CLOUD_GPU) === 'false' ? 2 : 0
  })(),
  /** GGUF context window — keep smaller on CPU to cut RAM/CPU thrash. */
  contextSize: (() => {
    const raw = process.env.ERIS_CLOUD_CONTEXT_SIZE
    if (raw != null && String(raw).trim() !== '') {
      return Math.max(512, Math.min(32768, Number(raw) || 2048))
    }
    // 7B Q4 + 4k ctx ≈ 7GB+ RSS — OOMs an 8g cgroup. Default 2k on CPU.
    return parseGpuMode(process.env.ERIS_CLOUD_GPU) === 'false' ? 2048 : 8192
  })(),
  /**
   * Load GGUF into RAM at process start.
   * Default OFF on CPU — boot-time loadModel+createContext was OOM-killing the VM
   * in a systemd restart loop. Model still loads on first job and stays cached.
   * Set ERIS_CLOUD_WARM_ON_START=1 to pre-load (GPU / larger hosts).
   */
  warmOnStart: (() => {
    const raw = process.env.ERIS_CLOUD_WARM_ON_START
    if (raw != null && String(raw).trim() !== '') {
      return raw === '1' || raw.toLowerCase() === 'true'
    }
    return parseGpuMode(process.env.ERIS_CLOUD_GPU) !== 'false'
  })(),
  llmBase: (process.env.ERIS_CLOUD_LLM_BASE || '').replace(/\/+$/, ''),
  llmKey: process.env.ERIS_CLOUD_LLM_KEY || '',
  llmModel: process.env.ERIS_CLOUD_LLM_MODEL || 'composer'
}

export function llmConfigured(): boolean {
  return true
}
