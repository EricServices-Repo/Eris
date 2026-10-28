import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { HASH_EMBEDDING_SPACE, sameEmbeddingSpace } from '../src/shared/embedding-space'
import { getDefaults } from '../electron/main/services/settings'
import { embedText } from '../electron/main/services/embeddings'
import {
  scanWorkspaceIndex,
  patchWorkspaceIndex
} from '../electron/main/services/workspace-index-job'
import {
  retrieveContextAsync,
  invalidateWorkspaceSearchCache
} from '../electron/main/services/workspace-search'
vi.mock('../electron/main/services/code-index', async () => {
  const { scanWorkspaceIndex } = await import('../electron/main/services/workspace-index-job')
  return {
    ensureCodeIndexAsync: async (root: string) =>
      scanWorkspaceIndex(root, join(root, '.eris', 'code-index.json')),
    loadCodeIndex: () => null
  }
})
afterEach(() => vi.unstubAllGlobals())
function settings() {
  const s = getDefaults()
  s.intelligence.embeddingProvider = 'connection'
  s.intelligence.embeddingModel = 'embed-test'
  s.intelligence.remoteEmbeddingPolicy = 'queries-only'
  s.models.connections = [
    {
      id: 'test',
      name: 'test',
      type: 'openai-compatible',
      provider: 'custom',
      enabled: true,
      baseUrl: 'https://example.invalid/v1',
      apiKeyRef: '',
      models: ['embed-test']
    }
  ]
  return s
}
describe('external embedding boundary', () => {
  it('requires explicit policy and input classification without transferring text', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const s = settings()
    s.intelligence.remoteEmbeddingPolicy = 'disabled'
    expect((await embedText('private text', s, () => null)).fallback).toBe('policy-disabled')
    s.intelligence.remoteEmbeddingPolicy = 'queries-only'
    expect((await embedText('private source', s, () => null)).remoteTransfer).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('labels provider vectors and refuses hash-space compatibility even with the same dimension', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: Array(128).fill(1) }] })))
    )
    const result = await embedText('query', settings(), () => null, { transfer: 'query' })
    expect(result.space.provider).toBe('test')
    expect(sameEmbeddingSpace(result.space, HASH_EMBEDDING_SPACE)).toBe(false)
  })
  it('reports timeout fallback and propagates caller cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u, options) =>
          new Promise((_r, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true
            })
          )
      )
    )
    expect(
      (await embedText('query', settings(), () => null, { transfer: 'query', timeoutMs: 50 }))
        .fallback
    ).toBe('timeout')
    const controller = new AbortController()
    const result = embedText('query', settings(), () => null, {
      transfer: 'query',
      signal: controller.signal
    })
    controller.abort()
    await expect(result).rejects.toThrow()
  })
  it('bounds response size and rejects malformed/nonfinite provider vectors', async () => {
    for (const body of [
      JSON.stringify({ data: [{ embedding: ['1', null] }] }),
      'x'.repeat(1024 * 1024 + 1)
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      )
      expect(
        (await embedText('query', settings(), () => null, { transfer: 'query' })).fallback
      ).toBe('invalid-response')
    }
  })
})
describe('versioned index and retrieval calibration', () => {
  it('rebuilds legacy/incompatible vectors and excludes private files; measures held-out query groups separately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-relevance-'))
    try {
      const docs: Record<string, string> = {
        'auth.ts':
          'export function verifyPassword() { /* compare credential digest before login */ }',
        'payments.ts':
          'export function chargeCard() { /* settle customer payment and issue receipt */ }',
        'cache.ts': 'export function invalidateCache() { /* evict stale cached entries */ }',
        'queue.ts':
          'export function cancelQueuedTask() { /* remove waiting job without stopping active work */ }',
        'search.ts': 'export function findDocuments() { /* rank document search results */ }',
        'image.ts': 'export function generateImage() { /* render prompt as picture */ }',
        'shipping.ts': 'export function trackParcel() { /* delivery shipment location */ }',
        'audio.ts': 'export function playSound() { /* speaker volume waveform */ }'
      }
      for (const [name, content] of Object.entries(docs)) writeFileSync(join(root, name), content)
      mkdirSync(join(root, 'private'))
      writeFileSync(join(root, 'private', 'secret.ts'), 'export function verifyPasswordSecret() {}')
      writeFileSync(join(root, '.erisignore'), 'private/\n')
      const path = join(root, '.eris', 'code-index.json'),
        index = await scanWorkspaceIndex(root, path)
      expect(index.files).not.toContain('private/secret.ts')
      expect(index.embeddingSpace).toEqual(HASH_EMBEDDING_SPACE)
      for (const change of [
        { provider: 'other' },
        { model: 'changed' },
        { dimensions: 64 },
        { tokenizer: 'v2' },
        { indexVersion: 99 }
      ]) {
        const bad = {
          ...index,
          embeddingSpace: { ...HASH_EMBEDDING_SPACE, ...change },
          embeddings: { 'auth.ts': [999] }
        }
        writeFileSync(path, JSON.stringify(bad))
        const fixed = await patchWorkspaceIndex(root, path, [])
        expect(fixed.embeddingSpace).toEqual(HASH_EMBEDDING_SPACE)
        expect(fixed.embeddings?.['auth.ts'].length).toBe(128)
      }
      const groups = {
        exact: [
          ['verifyPassword', 'auth.ts'],
          ['chargeCard', 'payments.ts'],
          ['invalidateCache', 'cache.ts'],
          ['cancelQueuedTask', 'queue.ts']
        ],
        meaning: [
          ['prove the visitor knows their secret', 'auth.ts'],
          ['bill a buyer for an order', 'payments.ts'],
          ['forget outdated saved values', 'cache.ts'],
          ['abort work before it starts', 'queue.ts']
        ]
      }
      const measurements = []
      for (const [group, queries] of Object.entries(groups)) {
        let correct = 0,
          precision = 0
        const timings: number[] = []
        for (const [query, relevant] of queries) {
          invalidateWorkspaceSearchCache(root)
          const at = performance.now(),
            result = await retrieveContextAsync(root, query, 3)
          timings.push(performance.now() - at)
          if (result.paths.includes(relevant)) {
            correct++
            precision += 1 / result.paths.length
          }
          expect(result.paths.some((p) => p.startsWith('private/'))).toBe(false)
          expect(result.provenance?.remoteTransfer).toBe(false)
          expect(result.detail).toContain('no learned semantic model')
        }
        measurements.push({
          group,
          queries: queries.length,
          recallAt3: correct / queries.length,
          meanPrecisionAtReturned: precision / queries.length,
          latencyMs: timings
        })
      }
      // Deliberately no semantic-quality gate: publish the limitation instead of tuning to the held-out queries.
      console.log('RETRIEVAL_CALIBRATION_V1', JSON.stringify(measurements))
      expect(measurements[0].recallAt3).toBe(1)
      expect(JSON.parse(readFileSync(path, 'utf8')).embeddingSpace).toEqual(HASH_EMBEDDING_SPACE)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
