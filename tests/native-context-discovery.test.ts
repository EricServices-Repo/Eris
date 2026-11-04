import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const h = vi.hoisted(() => ({ metadata: {} as object, reads: 0 }))
vi.mock('node-llama-cpp', () => ({
  readGgufFileInfo: async () => {
    h.reads++
    return { metadata: h.metadata }
  }
}))
import {
  discoverNativeContextWindow,
  nativeContextWindow
} from '../electron/main/services/native-context'
import { contextPlan } from '../electron/main/services/builtin-model'
import type { BuiltinModelManifestEntry } from '../src/shared/settings-schema'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const file = () => {
  const dir = mkdtempSync(join(tmpdir(), 'eris-context-metadata-'))
  dirs.push(dir)
  const path = join(dir, 'm.gguf')
  writeFileSync(path, 'fixture metadata is supplied by the reader double')
  return path
}
describe('native GGUF context discovery', () => {
  it('replaces the imported 32K placeholder with Qwen3.5 metadata for placement', async () => {
    const path = file()
    h.metadata = { general: { architecture: 'qwen35' }, qwen35: { context_length: 262144 } }
    const before = h.reads
    await discoverNativeContextWindow('local:qwen35', path)
    expect(nativeContextWindow('local:qwen35', 32768)).toBe(262144)
    const entry = {
      ref: 'local:qwen35',
      role: 'local',
      contextWindow: 32768,
      approxBytes: 3 * 1024 ** 3
    } as BuiltinModelManifestEntry
    expect(contextPlan(entry, 24 * 1024 ** 3, 262144)).toMatchObject({
      max: 262144,
      target: 262144
    })
    await discoverNativeContextWindow('local:qwen35', path)
    expect(h.reads).toBe(before + 1)
    writeFileSync(path, 'changed model')
    h.metadata = { general: { architecture: 'llama' }, llama: { context_length: 8192 } }
    await discoverNativeContextWindow('local:qwen35', path)
    expect(contextPlan(entry, 24 * 1024 ** 3, 262144).target).toBe(8192)
  })
  it('keeps unknown, missing and invalid metadata conservative and isolates models', async () => {
    const path = file()
    for (const value of [0, -1, NaN, Infinity, '262144', 2 ** 32]) {
      h.metadata = { general: { architecture: 'qwen35' }, qwen35: { context_length: value } }
      await discoverNativeContextWindow('local:bad', path)
      expect(nativeContextWindow('local:bad', 32768)).toBe(32768)
    }
    await discoverNativeContextWindow('local:qwen35', path + '.missing')
    expect(nativeContextWindow('local:qwen35', 8192)).toBe(8192)
  })
})
