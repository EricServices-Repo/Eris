export interface InferenceSnapshot {
  version: number
  platform: string
  memory: { total: number; free: number; reserve: number; reservationSource: string }
  devices: Array<{
    id: string
    name: string
    kind: 'unified' | 'dedicated'
    totalBytes: number
    freeBytes?: number
    source: 'driver-reported' | 'system-reported'
  }>
  active: Array<{
    id: number
    owner: string
    workload: string
    reservedBytes: number
    gpu: boolean
    deviceId: string | null
    deviceBytes: number
    queuedAt: number
    admittedAt?: number
    waitMs: number
  }>
  queued: Array<{
    id: number
    owner: string
    workload: string
    requestedBytes: number
    deviceId: string | null
    deviceBytes: number
    queuedAt: number
    deadline: number
    waitMs: number
    position: number
    reason: string
  }>
  incidents: Array<{
    id: number
    owner: string
    workload: string
    kind: string
    at: number
    waitMs: number
    reason: string
    deviceId: string | null
    estimatedHostBytes: number
    estimatedDeviceBytes: number
  }>
}
