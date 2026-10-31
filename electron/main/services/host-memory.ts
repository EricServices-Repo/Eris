import { execFile } from 'child_process'
import { freemem, totalmem } from 'os'

export type OsMemoryPressure = 'normal' | 'warn' | 'critical'
export type HostMemorySource = 'system-free' | 'macos-vm-counters'
export interface HostMemorySample {
  total: number
  /** Bytes the OS can hand out now without paging out active work. */
  available: number
  source: HostMemorySource
  /** The OS's own verdict. Absent where the platform has no equivalent signal. */
  osPressure?: OsMemoryPressure
}

/** A sampler that stops must not leave the governor trusting an old reading. */
const SAMPLE_MAX_AGE_MS = 20_000
const SAMPLE_INTERVAL_MS = 5_000
const COMMAND_TIMEOUT_MS = 1_500

/** free + inactive + speculative + purgeable: the pages macOS reclaims on demand. */
export function availableBytesFromVmStat(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1]
  if (!pageSize) return null
  let pages = 0
  for (const name of ['free', 'inactive', 'speculative', 'purgeable']) {
    const count = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(output)?.[1]
    if (!count) return null
    pages += Number(count)
  }
  return pages * Number(pageSize)
}

/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export function osPressureFromLevel(output: string): OsMemoryPressure | undefined {
  const level = Number(output.trim())
  return level === 1 ? 'normal' : level === 2 ? 'warn' : level === 4 ? 'critical' : undefined
}

type Run = (file: string, args: string[]) => Promise<string>
const run: Run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  )

/** Null means this host could not be measured; callers keep their plain free-memory reading. */
export async function sampleMacHostMemory(command: Run = run): Promise<HostMemorySample | null> {
  const [counters, pressure] = await Promise.allSettled([
    command('/usr/bin/vm_stat', []),
    command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])
  ])
  const available =
    counters.status === 'fulfilled' ? availableBytesFromVmStat(counters.value) : null
  if (available === null) return null
  return {
    total: totalmem(),
    available,
    source: 'macos-vm-counters',
    osPressure: pressure.status === 'fulfilled' ? osPressureFromLevel(pressure.value) : undefined
  }
}

let latest: { sample: HostMemorySample; at: number } | undefined

export function recordHostMemorySample(sample: HostMemorySample | null, at = Date.now()) {
  latest = sample ? { sample, at } : undefined
}

/**
 * The newest reading, synchronously: admission must never wait on a child process.
 * Elsewhere os.freemem() already reports OS-available memory including standby pages.
 */
export function currentHostMemory(now = Date.now()): HostMemorySample {
  if (latest && now - latest.at <= SAMPLE_MAX_AGE_MS) return latest.sample
  return { total: totalmem(), available: freemem(), source: 'system-free' }
}

/** Starts background sampling on platforms whose free-memory figure needs correcting. */
export function startHostMemorySampling(onSample: () => void, sample = sampleMacHostMemory) {
  if (process.platform !== 'darwin') return () => {}
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      recordHostMemorySample(await sample().catch(() => null))
      onSample()
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
