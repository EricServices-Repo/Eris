import { getGpuAccelStatus } from './gpu-accel'
import { updateInferenceDevices } from './inference-governor'
import type { GpuAccelStatus } from '../../../src/shared/settings-schema'
import type { InferenceDevice } from './inference-governor'

/**
 * An integrated GPU has no memory of its own on any backend: Apple Metal, an Intel or
 * AMD iGPU under Vulkan, or an APU all draw model weights from system RAM. It is
 * classed with unified memory, so admission charges host memory and no VRAM budget is
 * invented for it. Only a discrete or external device has separate VRAM.
 */
export function inferenceDeviceKind(
  device: Pick<GpuAccelStatus['devices'][number], 'kind'>
): InferenceDevice['kind'] {
  return device.kind === 'integrated' ? 'unified' : 'dedicated'
}

/** Discovery reports device capacity, never sums it into a fictional pooled device. */
export function inferenceDevicesFrom(
  status: Pick<GpuAccelStatus, 'backend' | 'devices'>
): InferenceDevice[] {
  return status.devices.map((d) => ({
    id: `${status.backend ?? 'unknown'}:${d.index}`,
    name: d.name,
    kind: inferenceDeviceKind(d),
    totalBytes: d.vramBytes ?? 0,
    freeBytes: d.vramFreeBytes,
    source: d.vramFreeBytes !== undefined ? 'driver-reported' : 'system-reported'
  }))
}

export async function inferenceDevice(peakBytes: number, deviceName?: string, prefer = true) {
  const status = await getGpuAccelStatus(prefer)
  const devices = inferenceDevicesFrom(status)
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
