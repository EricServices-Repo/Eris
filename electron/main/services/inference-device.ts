import { getGpuAccelStatus } from './gpu-accel'
import { updateInferenceDevices } from './inference-governor'
/** Discovery reports device capacity, never sums it into a fictional pooled device. */
export async function inferenceDevice(peakBytes: number, deviceName?: string, prefer = true) {
  const status = await getGpuAccelStatus(prefer)
  const devices = status.devices.map((d) => ({
    id: `${status.backend ?? 'unknown'}:${d.index}`,
    name: d.name,
    kind: (status.backend === 'metal' && d.kind === 'integrated' ? 'unified' : 'dedicated') as
      'unified' | 'dedicated',
    totalBytes: d.vramBytes ?? 0,
    freeBytes: d.vramFreeBytes,
    source: (d.vramFreeBytes !== undefined ? 'driver-reported' : 'system-reported') as
      'driver-reported' | 'system-reported'
  }))
  updateInferenceDevices(devices)
  const selected = deviceName
    ? devices.find((d) => d.name === deviceName)
    : devices.find((d) => d.name === status.preferredGpu?.name)
  const gpu = status.backend !== false
  return {
    gpu,
    deviceId: gpu ? selected?.id : undefined,
    deviceBytes:
      gpu && selected?.kind === 'dedicated'
        ? Math.min(peakBytes, Math.floor(selected.totalBytes * 0.8))
        : 0
  }
}
