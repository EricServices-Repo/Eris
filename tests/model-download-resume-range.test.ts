import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyResumeRange } from '../electron/main/services/http-download'
import { localModelsDir } from '../electron/main/services/paths'

const replies: Array<{ status: number; headers: Record<string, string>; body: Buffer }> = []
const requests: Array<Record<string, string>> = []

vi.mock('../electron/main/services/http-download', async (original) => {
  const actual = await original<typeof import('../electron/main/services/http-download')>()
  return {
    ...actual,
    downloadFetch: async (_url: string, init: { headers?: Record<string, string> }) => {
      requests.push(init.headers ?? {})
      const reply = replies.shift()!
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        headers: new Headers(reply.headers),
        body: new Blob([reply.body]).stream(),
        via: 'node-fetch'
      }
    }
  }
})

const MiB = 1024 * 1024
const full = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(3 * MiB - 4, 7)])
const entry = {
  id: 'range-test',
  ref: 'local:range-test',
  name: 'range-test',
  displayName: 'Range test',
  description: '',
  family: 'Test',
  quant: 'Q4',
  parameters: '1B',
  contextWindow: 4096,
  filename: 'range-test.gguf',
  downloadUrl: 'https://example.com/range-test.gguf',
  approxBytes: full.length,
  sha256: null,
  sizeLabel: '3 MB'
}
const target = () => join(localModelsDir(), entry.filename)

function seedPartial(bytes: number) {
  mkdirSync(localModelsDir(), { recursive: true })
  writeFileSync(
    join(localModelsDir(), 'catalog-extra.json'),
    JSON.stringify({ localModels: [entry] })
  )
  writeFileSync(`${target()}.partial`, full.subarray(0, bytes))
}

afterEach(() => {
  replies.length = 0
  requests.length = 0
  rmSync(target(), { force: true })
  rmSync(`${target()}.partial`, { force: true })
})

describe('classifyResumeRange', () => {
  const h = (range?: string) => new Headers(range ? { 'content-range': range } : {})
  it('appends only when the reply starts at the requested byte', () => {
    expect(classifyResumeRange(h('bytes 100-999/1000'), 100)).toBe('append')
    expect(classifyResumeRange(h('bytes 0-999/1000'), 100)).toBe('restart')
    expect(classifyResumeRange(h('bytes 50-999/1000'), 100)).toBe('mismatch')
    expect(classifyResumeRange(h('bytes 100-999/*'), 100)).toBe('append')
    expect(classifyResumeRange(h(), 100)).toBe('mismatch')
    expect(classifyResumeRange(h('garbage'), 100)).toBe('mismatch')
  })
})

describe('local model resume', () => {
  it('appends a 206 that starts at the partial size', async () => {
    const { downloadLocalModel } = await import('../electron/main/services/local-model')
    seedPartial(2 * MiB)
    replies.push({
      status: 206,
      headers: { 'content-range': `bytes ${2 * MiB}-${full.length - 1}/${full.length}` },
      body: full.subarray(2 * MiB)
    })
    await downloadLocalModel(entry.id)
    expect(requests[0]).toEqual({ Range: `bytes=${2 * MiB}-` })
    expect(readFileSync(target()).equals(full)).toBe(true)
  })

  it('replaces the partial when a 206 resends the file from byte 0', async () => {
    const { downloadLocalModel } = await import('../electron/main/services/local-model')
    seedPartial(2 * MiB)
    replies.push({
      status: 206,
      headers: { 'content-range': `bytes 0-${full.length - 1}/${full.length}` },
      body: full
    })
    await downloadLocalModel(entry.id)
    expect(readFileSync(target()).equals(full)).toBe(true)
  })

  it('refuses to append a 206 at a different offset and discards the partial', async () => {
    const { downloadLocalModel } = await import('../electron/main/services/local-model')
    seedPartial(2 * MiB)
    replies.push({
      status: 206,
      headers: { 'content-range': `bytes ${MiB}-${full.length - 1}/${full.length}` },
      body: full.subarray(MiB)
    })
    await expect(downloadLocalModel(entry.id)).rejects.toThrow(/different byte/)
    expect(existsSync(target())).toBe(false)
    expect(existsSync(`${target()}.partial`)).toBe(false)
  })
})
