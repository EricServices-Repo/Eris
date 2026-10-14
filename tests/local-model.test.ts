import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  findLocalEntry,
  isLocalRef,
  listLocalCatalog,
  localEntryAsBuiltin,
  resolveExactLocalRef
} from '../electron/main/services/local-model'

describe('local models catalog', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../resources/models/manifest.json'), 'utf8')
  ) as {
    localModels?: Array<{
      id: string
      ref: string
      downloadUrl: string
      filename: string
      approxBytes: number
      sizeLabel: string
      family?: string
    }>
  }

  it('ships a non-empty localModels catalog with GGUF URLs', () => {
    const list = manifest.localModels ?? []
    expect(list.length).toBeGreaterThanOrEqual(10)
    for (const m of list) {
      expect(m.ref).toMatch(/^local:/)
      expect(m.filename).toMatch(/\.gguf$/i)
      expect(m.downloadUrl).toMatch(/^https:\/\//)
      expect(m.approxBytes).toBeGreaterThan(100_000_000)
      expect(m.sizeLabel).toBeTruthy()
    }
  })

  it('includes Qwen3, coder, Gemma, Phi, and Llama options', () => {
    const refs = (manifest.localModels ?? []).map((m) => m.ref)
    const families = new Set((manifest.localModels ?? []).map((m) => m.family))
    expect(refs.some((r) => r.includes('qwen3'))).toBe(true)
    expect(refs.some((r) => r.includes('coder'))).toBe(true)
    expect(refs.some((r) => r.includes('gemma'))).toBe(true)
    expect(refs.some((r) => r.includes('phi'))).toBe(true)
    expect(refs.some((r) => r.includes('llama'))).toBe(true)
    expect(families.has('Mistral')).toBe(true)
  })

  it('loads the same catalog through the local-model service', () => {
    const list = listLocalCatalog()
    expect(list.length).toBe((manifest.localModels ?? []).length)
    expect(isLocalRef('local:qwen3-8b')).toBe(true)
    expect(isLocalRef('builtin:composer-lite')).toBe(false)
    const entry = findLocalEntry('local:qwen3-8b')
    expect(entry?.id).toBe('qwen3-8b')
    expect(localEntryAsBuiltin(entry!).role).toBe('local')
    // Not downloaded in CI — resolveExact should be null
    expect(resolveExactLocalRef('local:qwen3-8b')).toBeNull()
  })
})
