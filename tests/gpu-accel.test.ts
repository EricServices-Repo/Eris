import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { classifyMacBus, classifyWinName } from '../electron/main/services/gpu-accel'

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
})
