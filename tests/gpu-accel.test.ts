import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  classifyMacBus,
  classifyWinName,
  humanMacBus,
  pickBestGpu,
  rankGpuKind
} from '../electron/main/services/gpu-accel'
import type { GpuDeviceInfo } from '../src/shared/settings-schema'

describe('gpu / eGPU support', () => {
  it('defaults preferEgpu on for Local model acceleration', () => {
    const defaults = JSON.parse(
      readFileSync(join(__dirname, '../resources/defaults.json'), 'utf8')
    ) as { models?: { preferEgpu?: boolean } }
    expect(defaults.models?.preferEgpu).toBe(true)
  })

  it('classifies Thunderbolt / external adapters as eGPUs', () => {
    expect(classifyMacBus('Thunderbolt/USB4', 'AMD Radeon RX 6800 XT')).toBe('external')
    expect(classifyMacBus('Built-In', 'Apple M4')).toBe('integrated')
    expect(classifyMacBus('PCIe', 'AMD Radeon Pro W6800X')).toBe('discrete')
    expect(classifyWinName('NVIDIA GeForce RTX 3080', 'PCI\\VEN_10DE')).toBe('discrete')
    expect(classifyWinName('Intel UHD Graphics', 'PCI\\VEN_8086')).toBe('integrated')
    expect(classifyWinName('Razer Core X eGPU', 'PCI\\VEN_1002')).toBe('external')
  })

  it('humanizes macOS bus labels and hides raw profiler keys', () => {
    expect(humanMacBus('spdisplays_builtin')).toBe('Built-in')
    expect(humanMacBus('Thunderbolt/USB4')).toBe('Thunderbolt')
    expect(humanMacBus('PCIe')).toBe('PCIe')
    expect(humanMacBus('spdisplays_device-id')).toBeUndefined()
  })

  it('ranks best GPU as eGPU → discrete (VRAM) → integrated', () => {
    expect(rankGpuKind('external')).toBeGreaterThan(rankGpuKind('discrete'))
    expect(rankGpuKind('discrete')).toBeGreaterThan(rankGpuKind('integrated'))

    const devices: GpuDeviceInfo[] = [
      { name: 'Intel UHD', kind: 'integrated', index: 0, vramBytes: 1e9 },
      { name: 'RTX 3060', kind: 'discrete', index: 1, vramBytes: 12e9 },
      { name: 'RTX 4090', kind: 'discrete', index: 2, vramBytes: 24e9 },
      { name: 'Razer Core', kind: 'external', index: 3, vramBytes: 16e9 }
    ]
    expect(pickBestGpu(devices)?.name).toBe('Razer Core')
    expect(pickBestGpu(devices.filter((d) => d.kind !== 'external'))?.name).toBe('RTX 4090')
    expect(pickBestGpu(devices.filter((d) => d.kind === 'integrated'))?.name).toBe('Intel UHD')
    expect(pickBestGpu([])).toBeNull()
  })
})
