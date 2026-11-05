import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  classifyMacBus,
  classifyWinName,
  humanMacBus,
  gpusForVramShare,
  HIGH_VRAM_BYTES,
  llamaGpuPreferenceEnv,
  matchNvidiaVram,
  pickBestGpu,
  rankGpuKind
} from '../electron/main/services/gpu-accel'
import type { GpuDeviceInfo } from '../src/shared/settings-schema'

describe('gpu / eGPU support', () => {
  const preferred: GpuDeviceInfo = {
    name: 'NVIDIA GeForce RTX 5050',
    kind: 'discrete',
    index: 7,
    vramBytes: 8 * 1024 ** 3
  }
  const cuda = [
    { name: 'NVIDIA GeForce RTX 4060', index: 0 },
    { name: preferred.name, index: 1 }
  ]

  it('prioritizes the preferred CUDA GPU without hiding the second 8GB card', () => {
    expect(llamaGpuPreferenceEnv(true, { backend: 'cuda', preferredGpu: preferred }, cuda)).toEqual(
      { CUDA_VISIBLE_DEVICES: '1,0' }
    )
  })

  it('lets Vulkan discover all GPUs instead of masking with an OS adapter index', () => {
    expect(llamaGpuPreferenceEnv(true, { backend: 'vulkan', preferredGpu: preferred }, [])).toEqual(
      {}
    )
  })

  it('does not guess CUDA device IDs when the preferred adapter cannot be matched', () => {
    expect(
      llamaGpuPreferenceEnv(
        true,
        {
          backend: 'cuda',
          preferredGpu: { ...preferred, name: 'Unknown GPU' }
        },
        cuda
      )
    ).toEqual({})
    expect(
      llamaGpuPreferenceEnv(false, { backend: 'cuda', preferredGpu: preferred }, cuda)
    ).toEqual({})
    expect(
      llamaGpuPreferenceEnv(true, { backend: 'cuda', preferredGpu: preferred }, [cuda[1]!])
    ).toEqual({ CUDA_VISIBLE_DEVICES: '1' })
  })

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

  it('shares VRAM only across two or more 6GB-class discrete or external GPUs', () => {
    const six = HIGH_VRAM_BYTES
    const devices: GpuDeviceInfo[] = [
      { name: 'Intel UHD', kind: 'integrated', index: 0, vramBytes: 2e9 },
      { name: 'GTX 1650', kind: 'discrete', index: 1, vramBytes: 4 * 1024 ** 3 },
      { name: 'RTX 3060', kind: 'discrete', index: 2, vramBytes: six },
      { name: 'RTX 4070', kind: 'external', index: 3, vramBytes: 12 * 1024 ** 3 }
    ]
    expect(gpusForVramShare(devices).map((d) => d.name)).toEqual(['RTX 4070', 'RTX 3060'])
    expect(gpusForVramShare(devices.filter((d) => d.name !== 'RTX 4070'))).toEqual([])
  })

  describe('nvidia-smi memory for Windows adapters (#305)', () => {
    const GiB = 1024 ** 3
    // Win32_VideoController.AdapterRAM is a uint32, so large cards report about 4 GiB.
    const capped = 4 * GiB - 1

    it('never gives one card the memory of a different card that shares a name prefix', () => {
      const listed: GpuDeviceInfo[] = [
        { name: 'NVIDIA GeForce GTX 1050', kind: 'discrete', index: 0, vramBytes: 2 * GiB },
        { name: 'NVIDIA GeForce RTX 4090', kind: 'discrete', index: 1, vramBytes: capped }
      ]
      const cuda = [
        { name: 'NVIDIA GeForce RTX 4090', vramBytes: 24 * GiB, vramFreeBytes: 22 * GiB },
        { name: 'NVIDIA GeForce GTX 1050', vramBytes: 2 * GiB, vramFreeBytes: 1 * GiB }
      ]
      const [small, big] = matchNvidiaVram(listed, cuda)
      expect(small).toMatchObject({ vramBytes: 2 * GiB, vramFreeBytes: 1 * GiB })
      expect(big).toMatchObject({ vramBytes: 24 * GiB, vramFreeBytes: 22 * GiB })
      expect(pickBestGpu([small!, big!])?.name).toBe('NVIDIA GeForce RTX 4090')
    })

    it('keeps the OS figure for an adapter nvidia-smi does not name', () => {
      const listed: GpuDeviceInfo[] = [
        { name: 'NVIDIA GeForce GTX 1650', kind: 'discrete', index: 0, vramBytes: capped }
      ]
      const cuda = [
        { name: 'NVIDIA GeForce RTX 3090', vramBytes: 24 * GiB, vramFreeBytes: 20 * GiB }
      ]
      expect(matchNvidiaVram(listed, cuda)).toEqual(listed)
    })

    it('uses the smallest free memory when two cards share a name', () => {
      const listed: GpuDeviceInfo[] = [
        { name: 'NVIDIA GeForce RTX 3060', kind: 'discrete', index: 0, vramBytes: capped },
        { name: 'NVIDIA GeForce RTX 3060', kind: 'discrete', index: 1, vramBytes: capped }
      ]
      const cuda = [
        { name: 'NVIDIA GeForce RTX 3060', vramBytes: 12 * GiB, vramFreeBytes: 11 * GiB },
        { name: 'NVIDIA GeForce RTX 3060', vramBytes: 12 * GiB, vramFreeBytes: 3 * GiB }
      ]
      for (const device of matchNvidiaVram(listed, cuda))
        expect(device).toMatchObject({ vramBytes: 12 * GiB, vramFreeBytes: 3 * GiB })
    })

    it('matches names regardless of case and spacing, and never lowers a reported total', () => {
      const listed: GpuDeviceInfo[] = [
        { name: '  nvidia  GeForce RTX 4070 ', kind: 'discrete', index: 0, vramBytes: 12 * GiB }
      ]
      const cuda = [
        { name: 'NVIDIA GeForce RTX 4070', vramBytes: 11 * GiB, vramFreeBytes: 9 * GiB }
      ]
      expect(matchNvidiaVram(listed, cuda)[0]).toMatchObject({
        vramBytes: 12 * GiB,
        vramFreeBytes: 9 * GiB
      })
    })
  })
})
