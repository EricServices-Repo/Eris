import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GpuAccelStatus, GpuDeviceInfo } from '../src/shared/settings-schema'

const gpu = vi.hoisted(() => ({ status: null as unknown }))
vi.mock('../electron/main/services/gpu-accel', () => ({
  getGpuAccelStatus: async () => gpu.status
}))

import {
  inferenceDevice,
  inferenceDeviceKind,
  inferenceDevicesFrom
} from '../electron/main/services/inference-device'
import { hostClass } from '../electron/main/services/context-tier-budget'
import { inferenceGovernorStatus } from '../electron/main/services/inference-governor'
import { automaticTierBudget } from '../src/shared/context-tier-budget'

const G = 1024 ** 3
const device = (over: Partial<GpuDeviceInfo>): GpuDeviceInfo =>
  ({ index: 0, name: 'GPU', kind: 'discrete', vramBytes: 8 * G, ...over }) as GpuDeviceInfo
const status = (
  backend: GpuAccelStatus['backend'],
  devices: GpuDeviceInfo[],
  preferred = devices[0]
): GpuAccelStatus =>
  ({ backend, devices, preferredGpu: preferred ?? null }) as unknown as GpuAccelStatus

const INTEL = device({ name: 'Intel(R) Iris(R) Xe Graphics', kind: 'integrated', vramBytes: 2 * G })
const APU = device({
  name: 'AMD Radeon(TM) Graphics',
  kind: 'integrated',
  vramBytes: 512 * 1024 ** 2
})
const RTX = device({ index: 1, name: 'NVIDIA GeForce RTX 4070 Laptop GPU', vramBytes: 8 * G })
const APPLE = device({ name: 'Apple M4', kind: 'integrated', vramBytes: 12 * G })
const EGPU = device({ name: 'Radeon RX 7900 (eGPU)', kind: 'external', vramBytes: 20 * G })

beforeEach(() => {
  gpu.status = null
})

describe('inference device class (#330)', () => {
  it.each([
    ['Metal, Apple Silicon', 'metal', APPLE, 'unified'],
    ['Vulkan, Intel iGPU', 'vulkan', INTEL, 'unified'],
    ['Vulkan, AMD APU', 'vulkan', APU, 'unified'],
    ['CUDA, discrete', 'cuda', RTX, 'dedicated'],
    ['Vulkan, external', 'vulkan', EGPU, 'dedicated'],
    ['unknown backend, integrated', null, INTEL, 'unified']
  ] as const)('%s is %s', (_label, backend, gpuDevice, expected) => {
    expect(inferenceDeviceKind(gpuDevice)).toBe(expected)
    expect(inferenceDevicesFrom(status(backend, [gpuDevice]))[0]!.kind).toBe(expected)
  })

  it('never reports a VRAM budget for a shared-memory iGPU, on any backend', async () => {
    for (const shared of [INTEL, APU]) {
      gpu.status = status('vulkan', [shared])
      const placement = await inferenceDevice(6 * G)
      expect(placement).toMatchObject({ gpu: true, deviceBytes: 0 })
      expect(inferenceGovernorStatus().devices[0]).toMatchObject({ kind: 'unified' })
    }
    gpu.status = status('cuda', [RTX])
    expect((await inferenceDevice(6 * G)).deviceBytes).toBe(6 * G)
  })

  it('lists mixed devices separately without pooling their memory', () => {
    const devices = inferenceDevicesFrom(status('vulkan', [INTEL, RTX], RTX))
    expect(devices.map((d) => [d.id, d.kind, d.totalBytes])).toEqual([
      ['vulkan:0', 'unified', 2 * G],
      ['vulkan:1', 'dedicated', 8 * G]
    ])
  })
})

describe('tier host class from the device in use (#330)', () => {
  const mixed = inferenceDevicesFrom(status('vulkan', [INTEL, RTX], RTX))

  it('is unknown without discovery and shared for an iGPU-only host', () => {
    expect(hostClass([])).toBe('unknown')
    expect(hostClass(inferenceDevicesFrom(status('vulkan', [INTEL])))).toBe('unified')
    expect(hostClass(inferenceDevicesFrom(status('cuda', [RTX])))).toBe('dedicated')
  })

  it('stays conservative on a mixed host until the model holds the discrete GPU', () => {
    expect(hostClass(mixed)).toBe('unified')
    expect(hostClass(mixed, [{ gpu: true, deviceId: 'vulkan:1' }])).toBe('dedicated')
    expect(hostClass(mixed, [{ gpu: true, deviceId: 'vulkan:0' }])).toBe('unified')
    expect(
      hostClass(mixed, [
        { gpu: true, deviceId: 'vulkan:1' },
        { gpu: true, deviceId: 'vulkan:0' }
      ])
    ).toBe('unified')
    // CPU-only work does not say where the next GPU model will go.
    expect(hostClass(mixed, [{ gpu: false, deviceId: null }])).toBe('unified')
    // A lease on a device discovery never reported is not proof of separate VRAM.
    expect(hostClass(mixed, [{ gpu: true, deviceId: 'cuda:7' }])).toBe('unified')
  })

  it('sizes an iGPU host with the shared-memory share, not the dedicated one', () => {
    const host = {
      totalBytes: 16 * G,
      availableBytes: 8 * G,
      reserveBytes: 2 * G,
      modelBytes: 4 * G
    }
    const shared = automaticTierBudget({
      ...host,
      kind: hostClass(inferenceDevicesFrom(status('vulkan', [INTEL])))
    })
    const dedicated = automaticTierBudget({ ...host, kind: 'dedicated' })
    expect(shared.reason).toMatch(/shared memory/)
    expect(shared.memoryMiB).toBeLessThan(dedicated.memoryMiB)
  })

  it('leaves zero headroom with no more than the minimum tier', () => {
    const budget = automaticTierBudget({
      kind: hostClass(inferenceDevicesFrom(status('vulkan', [APU]))),
      totalBytes: 8 * G,
      availableBytes: 2 * G,
      reserveBytes: 2 * G,
      modelBytes: 2 * G
    })
    const floor = automaticTierBudget({
      kind: 'unified',
      totalBytes: 8 * G,
      availableBytes: 0,
      reserveBytes: 8 * G,
      modelBytes: 8 * G
    })
    expect(budget.memoryMiB).toBe(floor.memoryMiB)
  })
})
