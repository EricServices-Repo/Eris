/**
 * Detect eGPUs / discrete GPUs and steer node-llama-cpp toward them for local GGUFs.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { platform } from 'os'
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
    return rows.map((row, index) => {
      const name = String(
        row.sppci_model || row._name || row['spdisplays_device-id'] || `GPU ${index}`
      )
      const bus = String(row.sppci_bus || row.sppci_slot_name || '')
      const vramRaw = row.spdisplays_vram || row.sppci_vram || row['spdisplays_vram_shared']
      let vramBytes: number | undefined
      if (typeof vramRaw === 'string') {
        const m = vramRaw.match(/([\d.]+)\s*(MB|GB)/i)
        if (m) {
          const n = Number(m[1])
          vramBytes = /gb/i.test(m[2]) ? Math.round(n * 1e9) : Math.round(n * 1e6)
        }
      }
      return {
        name,
        kind: classifyMacBus(bus, name),
        bus: bus || undefined,
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

function pickPreferredGpu(devices: GpuDeviceInfo[]): GpuDeviceInfo | null {
  return devices.find((d) => d.kind === 'external') || devices.find((d) => d.kind === 'discrete') || null
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
  usable: boolean
}): string {
  if (options.egpu) {
    if (options.usable) {
      return `eGPU detected (${options.egpu.name}) — Local models can use it via ${options.backend || 'GPU'}${
        options.deviceName ? ` · ${options.deviceName}` : ''
      }.`
    }
    if (!options.preferEgpu) {
      return `eGPU detected (${options.egpu.name}) but preference is off — using default GPU/CPU.`
    }
    return `eGPU detected (${options.egpu.name}) but no compatible GPU backend is available yet (need Metal/CUDA/Vulkan).`
  }
  if (options.preferred?.kind === 'discrete' && options.usable) {
    return `Discrete GPU (${options.preferred.name}) available for Local models via ${options.backend}.`
  }
  if (options.backend) {
    return `No eGPU detected. Local models use ${options.backend}${
      options.deviceName ? ` (${options.deviceName})` : ''
    }.`
  }
  return 'No eGPU detected. Local models will run on CPU.'
}

export async function getGpuAccelStatus(preferEgpu = true): Promise<GpuAccelStatus> {
  if (cached && Date.now() - cached.at < 20_000 && cached.status.preferEgpu === preferEgpu) {
    return cached.status
  }

  const os = platform()
  const devices =
    os === 'darwin' ? await listMacGpus() : os === 'win32' ? await listWinGpus() : []
  const egpu = devices.find((d) => d.kind === 'external') ?? null
  const preferred = pickPreferredGpu(devices)
  const probed = await probeLlamaBackend()
  const backend = probed.backend ?? lastBackend
  // Prefer a concrete device name from a real model load when available.
  const deviceName =
    (lastBackend && lastBackend === backend && lastBackendDevice) ||
    probed.deviceName ||
    lastBackendDevice
  if (backend !== null && backend !== undefined) lastBackend = backend

  const wantsDiscrete = preferEgpu && !egpu && preferred?.kind === 'discrete'
  const backendOk = backend === 'metal' || backend === 'cuda' || backend === 'vulkan'
  // eGPU "usable" = external present + GPU backend available (Metal/CUDA/Vulkan).
  const egpuUsable = Boolean(egpu && preferEgpu && backendOk)
  const accelUsable = egpuUsable || Boolean(wantsDiscrete && backendOk)

  const status: GpuAccelStatus = {
    devices,
    egpu,
    preferredGpu: preferred,
    preferEgpu,
    egpuDetected: Boolean(egpu),
    egpuUsable,
    accelUsable,
    backend,
    backendDeviceName: deviceName,
    message: statusMessage({
      preferred,
      egpu,
      backend,
      deviceName,
      preferEgpu,
      usable: egpuUsable || (Boolean(egpu) && backendOk)
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
  const preferred = status.egpu || (preferEgpu ? status.preferredGpu : null)

  if (preferEgpu && preferred && status.backend === 'cuda') {
    const cuda = await listNvidiaCudaDevices()
    const match =
      cuda.find((d) => preferred.name.toLowerCase().includes(d.name.toLowerCase())) ||
      cuda.find((d) => d.name.toLowerCase().includes(preferred.name.toLowerCase().slice(0, 12))) ||
      (preferred.kind === 'external' || preferred.kind === 'discrete' ? cuda[cuda.length - 1] : null)
    if (match) {
      env.CUDA_VISIBLE_DEVICES = String(match.index)
    }
  }

  if (preferEgpu && preferred && status.backend === 'vulkan') {
    // Prefer non-zero index when multiple devices; index 0 is often iGPU.
    const idx =
      preferred.kind === 'external' || preferred.kind === 'discrete'
        ? Math.max(0, preferred.index)
        : 0
    env.GGML_VK_VISIBLE_DEVICES = String(idx)
  }

  // Metal uses the system default device; macOS "Prefer External GPU" / high-perf
  // policy routes MTLCreateSystemDefaultDevice to the eGPU when attached.
  if (preferEgpu && status.egpu && status.backend === 'metal') {
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
