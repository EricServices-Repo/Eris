/**
 * Detect eGPUs / discrete GPUs and steer node-llama-cpp toward them for local GGUFs.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { platform, totalmem } from 'os'
import type { GpuAccelStatus, GpuDeviceInfo } from '../../../src/shared/settings-schema'
import { logInfo, logWarn } from './logger'

const execFileAsync = promisify(execFile)

export type LlamaGpuBackend = 'metal' | 'cuda' | 'vulkan' | false

let cached: { at: number; status: GpuAccelStatus } | null = null
let appliedEnvKey = ''
let lastBackend: LlamaGpuBackend | null = null
let lastBackendDevice: string | null = null

/** Exported for unit tests. */
export function classifyMacBus(bus: string, name: string): GpuDeviceInfo['kind'] {
  const b = bus.toLowerCase()
  const n = name.toLowerCase()
  if (/thunderbolt|external|egpu/.test(b) || /egpu|external\s*gpu/.test(n)) return 'external'
  if (/built-?in|built in/.test(b)) return 'integrated'
  if (/pcie|pci express|slot/.test(b)) return 'discrete'
  if (/apple\s+m\d|intel\s+uhd|intel\s+iris|radeon graphics(?!\s+pro)/i.test(name)) {
    return 'integrated'
  }
  return 'discrete'
}

/** Exported for unit tests. */
export function classifyWinName(name: string, pnp: string): GpuDeviceInfo['kind'] {
  const n = name.toLowerCase()
  const p = pnp.toLowerCase()
  if (/egpu|external\s*gpu|thunderbolt/.test(n) || /thunderbolt|egpu/.test(p)) return 'external'
  if (
    /microsoft basic|remote desktop|virtual|parsec|citrix/.test(n) ||
    /intel\s*(uhd|iris|hd graphics)|amd\s*radeon\(tm\)\s*graphics|apple/.test(n)
  ) {
    return 'integrated'
  }
  if (/nvidia|geforce|rtx|quadro|tesla|radeon\s*rx|radeon\s*pro|arc\s*a\d/.test(n)) {
    return 'discrete'
  }
  return 'discrete'
}

/** Human bus/connection label — hide raw system_profiler keys. Exported for tests. */
export function humanMacBus(bus: string): string | undefined {
  const b = bus.trim()
  if (!b) return undefined
  const lower = b.toLowerCase()
  if (lower === 'spdisplays_builtin' || lower.includes('built-in') || lower.includes('builtin')) {
    return 'Built-in'
  }
  if (lower.includes('thunderbolt') || lower.includes('usb4')) return 'Thunderbolt'
  if (lower.includes('pcie') || lower.includes('pci express') || lower === 'pci') return 'PCIe'
  if (lower.startsWith('spdisplays_') || lower.startsWith('sppci_')) return undefined
  return b
}

function parseVramBytes(vramRaw: unknown): number | undefined {
  if (typeof vramRaw === 'number' && vramRaw > 0) return vramRaw
  if (typeof vramRaw !== 'string') return undefined
  const m = vramRaw.match(/([\d.]+)\s*(MB|GB)/i)
  if (!m) return undefined
  const n = Number(m[1])
  return /gb/i.test(m[2]) ? Math.round(n * 1e9) : Math.round(n * 1e6)
}

async function listMacGpus(): Promise<GpuDeviceInfo[]> {
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], {
      timeout: 12_000,
      maxBuffer: 4 * 1024 * 1024
    })
    const json = JSON.parse(stdout) as {
      SPDisplaysDataType?: Array<Record<string, unknown>>
    }
    const rows = json.SPDisplaysDataType ?? []
    const unifiedBytes = totalmem()
    return rows.map((row, index) => {
      const name = String(
        row.sppci_model || row._name || row['spdisplays_device-id'] || `GPU ${index}`
      )
      const rawBus = String(row.sppci_bus || row.sppci_slot_name || '')
      let vramBytes =
        parseVramBytes(row.spdisplays_vram) ||
        parseVramBytes(row.sppci_vram) ||
        parseVramBytes(row['spdisplays_vram_shared'])
      // Apple Silicon reports shared/unified memory, not discrete VRAM.
      if (!vramBytes && /apple\s+m\d/i.test(name) && unifiedBytes > 0) {
        vramBytes = unifiedBytes
      }
      return {
        name,
        kind: classifyMacBus(rawBus, name),
        bus: humanMacBus(rawBus),
        vramBytes,
        index
      }
    })
  } catch (err) {
    logWarn('macOS GPU enumeration failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return []
  }
}

async function listWinGpus(): Promise<GpuDeviceInfo[]> {
  try {
    const ps =
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,PNPDeviceID | ConvertTo-Json -Compress"
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
    )
    const raw = JSON.parse(stdout || '[]') as
      | Array<{ Name?: string; AdapterRAM?: number; PNPDeviceID?: string }>
      | { Name?: string; AdapterRAM?: number; PNPDeviceID?: string }
    const rows = Array.isArray(raw) ? raw : [raw]
    return rows
      .filter((r) => r?.Name)
      .map((r, index) => ({
        name: String(r.Name),
        kind: classifyWinName(String(r.Name), String(r.PNPDeviceID || '')),
        bus: r.PNPDeviceID ? String(r.PNPDeviceID).slice(0, 48) : undefined,
        vramBytes:
          typeof r.AdapterRAM === 'number' && r.AdapterRAM > 0 ? r.AdapterRAM : undefined,
        index
      }))
  } catch (err) {
    logWarn('Windows GPU enumeration failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return []
  }
}

async function listNvidiaCudaDevices(): Promise<Array<{ index: number; name: string }>> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,name', '--format=csv,noheader,nounits'],
      { timeout: 8_000 }
    )
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [idx, ...rest] = line.split(',').map((s) => s.trim())
        return { index: Number(idx), name: rest.join(', ') }
      })
      .filter((d) => Number.isFinite(d.index) && d.name)
  } catch {
    return []
  }
}

/** Kind rank: eGPU > discrete GPU > integrated. Exported for tests. */
export function rankGpuKind(kind: GpuDeviceInfo['kind']): number {
  if (kind === 'external') return 3
  if (kind === 'discrete') return 2
  return 1
}

/**
 * Best GPU for Local models: eGPU first, then discrete (most VRAM), then integrated.
 * Exported for unit tests.
 */
export function pickBestGpu(devices: GpuDeviceInfo[]): GpuDeviceInfo | null {
  if (!devices.length) return null
  return [...devices].sort((a, b) => {
    const byKind = rankGpuKind(b.kind) - rankGpuKind(a.kind)
    if (byKind !== 0) return byKind
    return (b.vramBytes ?? 0) - (a.vramBytes ?? 0)
  })[0]!
}

function accelTierFor(
  preferred: GpuDeviceInfo | null,
  backendOk: boolean,
  preferBest: boolean
): 'egpu' | 'gpu' | 'cpu' {
  if (!preferBest || !backendOk || !preferred) return 'cpu'
  if (preferred.kind === 'external') return 'egpu'
  return 'gpu'
}

async function probeLlamaBackend(): Promise<{
  backend: LlamaGpuBackend
  deviceName: string | null
}> {
  if (process.env.ERIS_SKIP_LLAMA_GPU_PROBE === '1' || process.env.VITEST) {
    return { backend: lastBackend ?? false, deviceName: lastBackendDevice }
  }
  try {
    const llamaCpp = await import('node-llama-cpp')
    // dryRun: load binary bindings only — fast enough for Settings refresh.
    const llama = await llamaCpp.getLlama({
      gpu: 'auto',
      build: 'never',
      progressLogs: false,
      dryRun: true
    })
    const backend = (llama.gpu === false ? false : llama.gpu) as LlamaGpuBackend
    const deviceName = backend ? String(backend) : null
    await llama.dispose().catch(() => undefined)
    return { backend, deviceName }
  } catch (err) {
    logWarn('llama GPU probe failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return { backend: false, deviceName: null }
  }
}

function statusMessage(options: {
  preferred: GpuDeviceInfo | null
  egpu: GpuDeviceInfo | null
  backend: LlamaGpuBackend
  deviceName: string | null
  preferEgpu: boolean
  tier: 'egpu' | 'gpu' | 'cpu'
  deviceCount: number
}): string {
  const backendLabel = options.backend
    ? `${options.backend}${options.deviceName ? ` · ${options.deviceName}` : ''}`
    : null
  const priority = 'Priority: best GPU → eGPU → GPU → CPU'

  if (!options.preferEgpu) {
    return `${priority}. Preference off — Local models use the default ${backendLabel || 'GPU/CPU'} path.`
  }

  if (options.tier === 'egpu' && options.egpu) {
    return `${priority}. Using eGPU (${options.egpu.name}) via ${backendLabel || 'GPU'}.`
  }

  if (options.tier === 'gpu' && options.preferred) {
    const kind =
      options.preferred.kind === 'discrete' ? 'discrete GPU' : 'integrated GPU'
    return `${priority}. Using ${kind} (${options.preferred.name}) via ${backendLabel || 'GPU'}.`
  }

  if (options.egpu && !options.backend) {
    return `${priority}. eGPU detected (${options.egpu.name}) but no Metal/CUDA/Vulkan backend — falling back to CPU.`
  }

  if (options.deviceCount > 0 && options.backend) {
    return `${priority}. GPU listed, but selection fell through to ${backendLabel}.`
  }

  if (options.backend) {
    return `${priority}. No dedicated GPU selected — Local models use ${backendLabel}.`
  }

  return `${priority}. No usable GPU — Local models will run on CPU.`
}

export async function getGpuAccelStatus(preferEgpu = true): Promise<GpuAccelStatus> {
  if (cached && Date.now() - cached.at < 20_000 && cached.status.preferEgpu === preferEgpu) {
    return cached.status
  }

  const os = platform()
  const devices =
    os === 'darwin' ? await listMacGpus() : os === 'win32' ? await listWinGpus() : []
  const egpu = devices.find((d) => d.kind === 'external') ?? null
  const preferred = pickBestGpu(devices)
  const probed = await probeLlamaBackend()
  const backend = probed.backend ?? lastBackend
  // Prefer a concrete device name from a real model load when available.
  const deviceName =
    (lastBackend && lastBackend === backend && lastBackendDevice) ||
    probed.deviceName ||
    lastBackendDevice
  if (backend !== null && backend !== undefined) lastBackend = backend

  const backendOk = backend === 'metal' || backend === 'cuda' || backend === 'vulkan'
  const egpuUsable = Boolean(egpu && preferEgpu && backendOk)
  const accelUsable = Boolean(preferEgpu && preferred && backendOk)
  const accelTier = accelTierFor(preferred, backendOk, preferEgpu)

  const status: GpuAccelStatus = {
    devices,
    egpu,
    preferredGpu: preferred,
    preferEgpu,
    egpuDetected: Boolean(egpu),
    egpuUsable,
    accelUsable,
    accelTier,
    backend,
    backendDeviceName: deviceName,
    message: statusMessage({
      preferred,
      egpu,
      backend,
      deviceName,
      preferEgpu,
      tier: accelTier,
      deviceCount: devices.length
    })
  }
  cached = { at: Date.now(), status }
  return status
}

export function invalidateGpuAccelCache(): void {
  cached = null
}

/**
 * Apply process env so llama.cpp prefers an eGPU / discrete GPU before getLlama().
 * Safe to call repeatedly; returns true when env changed (caller should reload models).
 */
export async function applyLlamaGpuPreference(preferEgpu = true): Promise<{
  changed: boolean
  env: Record<string, string>
  status: GpuAccelStatus
}> {
  const status = await getGpuAccelStatus(preferEgpu)
  const env: Record<string, string> = {}
  // Best GPU when preference is on: eGPU → discrete → integrated.
  const preferred = preferEgpu ? status.preferredGpu : null

  if (preferEgpu && preferred && status.backend === 'cuda') {
    const cuda = await listNvidiaCudaDevices()
    const match =
      cuda.find((d) => preferred.name.toLowerCase().includes(d.name.toLowerCase())) ||
      cuda.find((d) => d.name.toLowerCase().includes(preferred.name.toLowerCase().slice(0, 12))) ||
      (preferred.kind === 'external' || preferred.kind === 'discrete'
        ? cuda[cuda.length - 1]
        : cuda[0] || null)
    if (match) {
      env.CUDA_VISIBLE_DEVICES = String(match.index)
    }
  }

  if (preferEgpu && preferred && status.backend === 'vulkan') {
    // Prefer the preferred device index; index 0 is often iGPU when a dGPU exists.
    const idx = Math.max(0, preferred.index)
    env.GGML_VK_VISIBLE_DEVICES = String(idx)
  }

  // Metal uses the system default device; macOS "Prefer External GPU" / high-perf
  // policy routes MTLCreateSystemDefaultDevice to the eGPU when attached.
  if (preferEgpu && preferred?.kind === 'external' && status.backend === 'metal') {
    env.GGML_METAL_DEVICES = '1'
  }

  const key = JSON.stringify(env)
  const changed = key !== appliedEnvKey
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v
  }
  // Clear previously applied keys that are no longer set
  for (const k of ['CUDA_VISIBLE_DEVICES', 'GGML_VK_VISIBLE_DEVICES'] as const) {
    if (!(k in env) && appliedEnvKey.includes(k)) {
      delete process.env[k]
    }
  }
  appliedEnvKey = key
  if (changed && Object.keys(env).length) {
    logInfo('Applied llama GPU preference env', env)
  }
  return { changed, env, status }
}

/** Options for getLlama() after preference is applied. */
export function llamaGpuOption(preferEgpu: boolean, status?: GpuAccelStatus): 'auto' | false {
  if (!preferEgpu) return 'auto'
  if (status?.backend === false) return 'auto'
  return 'auto'
}

export function getLastLlamaBackend(): {
  backend: LlamaGpuBackend | null
  deviceName: string | null
} {
  return { backend: lastBackend, deviceName: lastBackendDevice }
}

export function noteLlamaBackend(backend: LlamaGpuBackend, deviceName?: string | null): void {
  lastBackend = backend
  if (deviceName !== undefined) lastBackendDevice = deviceName
  // Refresh Settings card on next modelsStatus() call.
  if (cached) cached = null
}
