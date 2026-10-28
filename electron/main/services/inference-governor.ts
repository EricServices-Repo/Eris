import type { InferenceSnapshot } from '../../../src/shared/inference'
import { freemem, totalmem } from 'os'
export type InferenceWorkload = 'text' | 'image' | 'embedding' | 'index'
export interface InferenceDevice {
  id: string
  name: string
  kind: 'unified' | 'dedicated'
  totalBytes: number
  freeBytes?: number
  source: 'driver-reported' | 'system-reported'
}
export interface InferenceOptions {
  workload: InferenceWorkload
  requestedBytes: number
  gpu?: boolean
  exclusiveGpu?: boolean
  priority?: number
  signal?: AbortSignal
  owner?: string
  deviceId?: string
  deviceBytes?: number
  waitTimeoutMs?: number
  onWait?: (state: { id: number; owner: string; waitMs: number; reason: string }) => void
}
export type InferenceLease = {
  id: number
  workload: InferenceWorkload
  reservedBytes: number
  deviceId: string | null
  deviceBytes: number
  waitMs: number
  release: () => void
}
type Row = InferenceOptions & {
  id: number
  owner: string
  gpu: boolean
  exclusiveGpu: boolean
  priority: number
  deviceBytes: number
  queuedAt: number
  admittedAt?: number
  deadline: number
  resolve: (lease: InferenceLease) => void
  reject: (error: Error) => void
  detach: () => void
  reason: string
}
/** One main-process owner. Worker threads must acquire through their parent, not a separate module instance. */
export class InferenceGovernor {
  private sequence = 0
  private pending: Row[] = []
  private active = new Map<number, Row>()
  private devices: InferenceDevice[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private incidents: Array<{
    id: number
    owner: string
    workload: InferenceWorkload
    kind: string
    at: number
    waitMs: number
    reason: string
    deviceId: string | null
    estimatedHostBytes: number
    estimatedDeviceBytes: number
  }> = []
  constructor(
    private memory = () => ({
      total: totalmem(),
      free: freemem(),
      reserve: Math.max(2 * 1024 ** 3, totalmem() * (process.platform === 'darwin' ? 0.25 : 0.15))
    }),
    private now = () => Date.now()
  ) {}
  setDevices(devices: InferenceDevice[]) {
    this.devices = devices
      .filter((d) => Number.isFinite(d.totalBytes) && d.totalBytes > 0)
      .map((d) => ({ ...d }))
    this.drain()
  }
  private note(row: Row, kind: string, reason: string) {
    this.incidents.push({
      id: row.id,
      owner: row.owner,
      workload: row.workload,
      kind,
      reason,
      at: this.now(),
      waitMs: this.now() - row.queuedAt,
      deviceId: row.deviceId ?? null,
      estimatedHostBytes: row.requestedBytes,
      estimatedDeviceBytes: row.deviceBytes
    })
    this.incidents = this.incidents.slice(-50)
  }
  private reason(row: Row): string | null {
    const memory = this.memory(),
      reserved = [...this.active.values()].reduce((n, r) => n + r.requestedBytes, 0)
    if (row.requestedBytes + reserved > Math.max(0, memory.total - memory.reserve))
      return 'Waiting for reserved host/unified memory'
    if (this.active.size && row.requestedBytes > Math.max(0, memory.free - memory.reserve))
      return 'Waiting for available host memory'
    if (!row.gpu) return null
    // Backends may use more devices than their reported primary; retain global GPU exclusivity until an exact assignment is confirmed.
    const gpu = [...this.active.values()].filter((r) => r.gpu)
    if (gpu.length && (row.exclusiveGpu || gpu.some((r) => r.exclusiveGpu)))
      return `Waiting for GPU owner ${gpu[0].owner}`
    const device = this.devices.find((d) => d.id === row.deviceId)
    if (device?.kind === 'dedicated') {
      const reservedVram = [...this.active.values()]
        .filter((r) => r.deviceId === device.id)
        .reduce((n, r) => n + r.deviceBytes, 0)
      if (row.deviceBytes + reservedVram > device.totalBytes * 0.9)
        return 'Waiting for this device VRAM reservation'
    }
    return null
  }
  acquire(options: InferenceOptions): Promise<InferenceLease> {
    if (options.signal?.aborted)
      return Promise.reject(
        Object.assign(new Error('Cancelled before inference admission'), { name: 'AbortError' })
      )
    if (
      !Number.isFinite(options.requestedBytes) ||
      options.requestedBytes < 0 ||
      !Number.isFinite(options.deviceBytes ?? 0) ||
      (options.deviceBytes ?? 0) < 0 ||
      !Number.isFinite(options.priority ?? 0) ||
      !Number.isFinite(options.waitTimeoutMs ?? 120000)
    )
      return Promise.reject(new Error('Invalid inference reservation'))
    const memory = this.memory(),
      device = this.devices.find((d) => d.id === options.deviceId)
    if (options.requestedBytes > Math.max(0, memory.total - memory.reserve))
      return Promise.reject(
        new Error('Estimated workload exceeds safe host/unified-memory capacity')
      )
    if (device?.kind === 'dedicated' && (options.deviceBytes ?? 0) > device.totalBytes * 0.9)
      return Promise.reject(
        new Error('Estimated workload exceeds this device VRAM; devices are not pooled')
      )
    return new Promise((resolve, reject) => {
      const row: Row = {
        ...options,
        id: ++this.sequence,
        owner: (options.owner ?? options.workload).slice(0, 256),
        requestedBytes: Math.ceil(options.requestedBytes),
        gpu: options.gpu !== false,
        exclusiveGpu: options.exclusiveGpu !== false,
        priority: options.priority ?? (options.workload === 'text' ? 20 : 10),
        deviceBytes: Math.ceil(options.deviceBytes ?? 0),
        queuedAt: this.now(),
        deadline: this.now() + Math.max(1, Math.min(600000, options.waitTimeoutMs ?? 120000)),
        resolve,
        reject,
        detach: () => {},
        reason: 'Queued for local inference'
      }
      const abort = () => {
        if (!this.pending.includes(row)) return
        this.pending = this.pending.filter((r) => r !== row)
        row.detach()
        this.note(row, 'cancelled', 'Owner cancelled queued request')
        reject(
          Object.assign(new Error('Cancelled while queued for inference'), { name: 'AbortError' })
        )
        this.drain()
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      row.detach = () => options.signal?.removeEventListener('abort', abort)
      this.pending.push(row)
      this.drain()
    })
  }
  drain(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const time = this.now()
    for (const row of [...this.pending])
      if (time >= row.deadline) {
        this.pending = this.pending.filter((r) => r !== row)
        row.detach()
        this.note(row, 'timeout', row.reason)
        row.reject(
          Object.assign(new Error(`Inference queue deadline exceeded: ${row.reason}`), {
            code: 'INFERENCE_QUEUE_TIMEOUT'
          })
        )
      }
    // Once any request waits two seconds, FIFO is a reservation barrier: smaller new
    // work cannot perpetually consume the capacity the older request needs.
    this.pending.sort(
      (a, b) =>
        Number(time - b.queuedAt >= 2000) - Number(time - a.queuedAt >= 2000) ||
        (time - a.queuedAt >= 2000 || time - b.queuedAt >= 2000
          ? a.id - b.id
          : b.priority - a.priority || a.id - b.id)
    )
    for (const row of [...this.pending]) {
      const reason = this.reason(row)
      if (reason) {
        row.reason = reason
        try {
          row.onWait?.({ id: row.id, owner: row.owner, waitMs: time - row.queuedAt, reason })
        } catch {
          /* observers do not own admission */
        }
        if (time - row.queuedAt >= 2000) break
        continue
      }
      this.pending = this.pending.filter((r) => r !== row)
      row.detach()
      row.admittedAt = time
      this.active.set(row.id, row)
      this.note(row, 'admitted', 'Peak reservation admitted')
      let released = false
      row.resolve({
        id: row.id,
        workload: row.workload,
        reservedBytes: row.requestedBytes,
        deviceId: row.deviceId ?? null,
        deviceBytes: row.deviceBytes,
        waitMs: time - row.queuedAt,
        release: () => {
          if (released) return
          released = true
          this.active.delete(row.id)
          this.note(row, 'released', 'Reservation released; physical cleanup remains runtime-owned')
          this.drain()
        }
      })
    }
    if (this.pending.length) {
      this.timer = setTimeout(
        () => this.drain(),
        Math.max(1, Math.min(1000, ...this.pending.map((r) => r.deadline - this.now())))
      )
      this.timer.unref?.()
    }
  }
  status(): InferenceSnapshot {
    return {
      version: 1,
      platform: process.platform,
      memory: {
        ...this.memory(),
        reservationSource:
          'estimated active peak; free system-reported; cached residency requires load preflight'
      },
      devices: this.devices.map((d) => ({ ...d })),
      active: [...this.active.values()].map((r) => ({
        id: r.id,
        owner: r.owner,
        workload: r.workload,
        reservedBytes: r.requestedBytes,
        gpu: r.gpu,
        deviceId: r.deviceId ?? null,
        deviceBytes: r.deviceBytes,
        queuedAt: r.queuedAt,
        admittedAt: r.admittedAt,
        waitMs: (r.admittedAt ?? this.now()) - r.queuedAt
      })),
      queued: this.pending.map((r, index) => ({
        id: r.id,
        owner: r.owner,
        workload: r.workload,
        requestedBytes: r.requestedBytes,
        deviceId: r.deviceId ?? null,
        deviceBytes: r.deviceBytes,
        queuedAt: r.queuedAt,
        deadline: r.deadline,
        waitMs: this.now() - r.queuedAt,
        position: index + 1,
        reason: r.reason
      })),
      incidents: [...this.incidents]
    }
  }
}
const governor = new InferenceGovernor()
export const acquireInferenceLease = (options: InferenceOptions) => governor.acquire(options)
export const inferenceGovernorStatus = () => governor.status()
export const updateInferenceDevices = (devices: InferenceDevice[]) => governor.setDevices(devices)
