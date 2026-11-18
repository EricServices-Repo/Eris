import { describe, expect, it } from 'vitest'
import {
  FIT_STEP_TOKENS,
  KV_ELEMENT_BYTES,
  MIN_FIT_WINDOW,
  PER_GPU_RESERVE_BYTES,
  PLAN_RESERVE_SHARE,
  SPILL_HEADROOM_BYTES,
  estimateKvBytesPerToken,
  fitAfterOutOfMemory,
  fitAfterSpill,
  isOutOfMemoryError,
  learnedKvBytesPerToken,
  planWindowForBudget
} from '../electron/main/services/ollama-context-fit'
import { connectionFromDraft, withPrimaryOllama } from '../src/features/settings/ollama-connections'
import { primaryOllamaConnection } from '../src/shared/eris-cloud'
import type { ModelConnection } from '../src/shared/settings-schema'

/** #677: fitting Ollama windows to VRAM. */
const GIB = 1024 ** 3
const MIB = 1024 ** 2

// qwen3-coder:30b (qwen3moe): 48 layers, 4 KV heads, 128-dim keys and values.
const qwen3moe = {
  'general.architecture': 'qwen3moe',
  'qwen3moe.block_count': 48,
  'qwen3moe.attention.head_count': 32,
  'qwen3moe.attention.head_count_kv': 4,
  'qwen3moe.attention.key_length': 128,
  'qwen3moe.attention.value_length': 128,
  'qwen3moe.embedding_length': 2048
}

describe('estimateKvBytesPerToken', () => {
  it('computes a dense GQA cache at each cache type', () => {
    const elements = 48 * 4 * (128 + 128)
    expect(estimateKvBytesPerToken(qwen3moe)).toBe(elements * 2)
    expect(estimateKvBytesPerToken(qwen3moe, 'q8_0')).toBe(Math.ceil(elements * KV_ELEMENT_BYTES.q8_0))
    expect(estimateKvBytesPerToken(qwen3moe, 'q4_0')).toBe(Math.ceil(elements * KV_ELEMENT_BYTES.q4_0))
    // 32K tokens at f16 is 3 GiB: the figure in the issue.
    expect((estimateKvBytesPerToken(qwen3moe)! * 32768) / GIB).toBe(3)
  })

  it('derives the head dimension when key and value lengths are absent', () => {
    const llama = {
      'general.architecture': 'llama',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.attention.head_count_kv': 8,
      'llama.embedding_length': 4096
    }
    expect(estimateKvBytesPerToken(llama)).toBe(32 * 8 * (128 + 128) * 2)
  })

  it('counts only attention layers from a per-layer head list', () => {
    const hybrid = {
      'general.architecture': 'lfm2',
      'lfm2.block_count': 6,
      'lfm2.attention.head_count': 16,
      'lfm2.attention.head_count_kv': [0, 0, 8, 0, 0, 8],
      'lfm2.attention.key_length': 64,
      'lfm2.attention.value_length': 64
    }
    expect(estimateKvBytesPerToken(hybrid)).toBe(16 * 128 * 2)
  })

  it('counts only full-attention layers in an interval hybrid', () => {
    const next = {
      'general.architecture': 'qwen3next',
      'qwen3next.block_count': 48,
      'qwen3next.full_attention_interval': 4,
      'qwen3next.attention.head_count': 16,
      'qwen3next.attention.head_count_kv': 2,
      'qwen3next.attention.key_length': 256,
      'qwen3next.attention.value_length': 256
    }
    expect(estimateKvBytesPerToken(next)).toBe(12 * 2 * 512 * 2)
  })

  it('returns null when the cache cannot be described', () => {
    expect(estimateKvBytesPerToken(undefined)).toBeNull()
    expect(estimateKvBytesPerToken({ 'general.architecture': 'x' })).toBeNull()
    expect(estimateKvBytesPerToken({ 'general.architecture': 'x', 'x.block_count': 4 })).toBeNull()
    expect(
      estimateKvBytesPerToken({
        'general.architecture': 'x',
        'x.block_count': 2,
        'x.attention.head_count_kv': [0, 0],
        'x.attention.key_length': 64
      })
    ).toBeNull()
  })
})

describe('learnedKvBytesPerToken', () => {
  it('takes the slope between two loads in either order', () => {
    const a = { window: 8192, sizeBytes: 20 * GIB }
    const b = { window: 16384, sizeBytes: 20 * GIB + 8192 * 98304 }
    expect(learnedKvBytesPerToken(a, b)).toBe(98304)
    expect(learnedKvBytesPerToken(b, a)).toBe(98304)
  })

  it('rejects equal windows, shrinking sizes and implausible slopes', () => {
    const a = { window: 8192, sizeBytes: 20 * GIB }
    expect(learnedKvBytesPerToken(a, { window: 8192, sizeBytes: 21 * GIB })).toBeNull()
    expect(learnedKvBytesPerToken(a, { window: 16384, sizeBytes: 19 * GIB })).toBeNull()
    expect(learnedKvBytesPerToken(a, { window: 9216, sizeBytes: 40 * GIB })).toBeNull()
  })
})

describe('fitAfterSpill', () => {
  const perToken = 98304

  it('does nothing when the model is fully in VRAM', () => {
    expect(
      fitAfterSpill({ requested: 32768, window: 32768, sizeBytes: GIB, vramBytes: GIB, bytesPerToken: perToken })
    ).toBeNull()
  })

  it('removes the tokens that spilled, plus headroom, on a 1,024 boundary', () => {
    const spill = 1 * GIB
    const fit = fitAfterSpill({
      requested: 131072,
      window: 131072,
      sizeBytes: 30 * GIB,
      vramBytes: 30 * GIB - spill,
      bytesPerToken: perToken
    })!
    const expected =
      Math.floor((131072 - Math.ceil((spill + SPILL_HEADROOM_BYTES) / perToken)) / FIT_STEP_TOKENS) *
      FIT_STEP_TOKENS
    expect(fit).toEqual({ window: expected, reason: 'spill' })
    expect(fit.window % FIT_STEP_TOKENS).toBe(0)
    // The fitted window's cache is at least the spill smaller.
    expect((131072 - fit.window) * perToken).toBeGreaterThanOrEqual(spill)
  })

  it('shrinks by the headroom and at least one step, even for a one-byte spill', () => {
    const fit = fitAfterSpill({
      requested: 32768,
      window: 32768,
      sizeBytes: GIB + 1,
      vramBytes: GIB,
      bytesPerToken: perToken
    })!
    const cut = Math.ceil((1 + SPILL_HEADROOM_BYTES) / perToken)
    expect(fit.window).toBe(Math.floor((32768 - cut) / FIT_STEP_TOKENS) * FIT_STEP_TOKENS)
    expect(fit.window).toBeLessThanOrEqual(32768 - FIT_STEP_TOKENS)
    // With a huge per-token cost the step rule still applies.
    expect(
      fitAfterSpill({ requested: 32768, window: 32768, sizeBytes: GIB + 1, vramBytes: GIB, bytesPerToken: 4 * MIB })!
        .window
    ).toBe(32768 - FIT_STEP_TOKENS * Math.ceil((1 + SPILL_HEADROOM_BYTES) / (4 * MIB) / FIT_STEP_TOKENS))
  })

  it('halves when the per-token cost is unknown', () => {
    expect(
      fitAfterSpill({ requested: 65536, window: 65536, sizeBytes: 2, vramBytes: 1, bytesPerToken: null })
    ).toEqual({ window: 32768, reason: 'spill' })
    expect(
      fitAfterSpill({ requested: 12288, window: 12288, sizeBytes: 2, vramBytes: 1, bytesPerToken: null })
    ).toEqual({ window: MIN_FIT_WINDOW, reason: 'spill' })
  })

  it('stops at the floor and reports weights that cannot fit', () => {
    const tooBig = fitAfterSpill({
      requested: 32768,
      window: 32768,
      sizeBytes: 40 * GIB,
      vramBytes: 24 * GIB,
      bytesPerToken: perToken
    })
    expect(tooBig).toEqual({ window: MIN_FIT_WINDOW, reason: 'spill', weightsExceedVram: true })
    const atFloor = fitAfterSpill({
      requested: 32768,
      window: MIN_FIT_WINDOW,
      sizeBytes: 2,
      vramBytes: 1,
      bytesPerToken: null
    })
    expect(atFloor).toEqual({ window: MIN_FIT_WINDOW, reason: 'spill', weightsExceedVram: true })
  })

  it('never goes below a requested window that is already under the floor', () => {
    expect(
      fitAfterSpill({ requested: 4096, window: 4096, sizeBytes: 2, vramBytes: 1, bytesPerToken: null })
    ).toEqual({ window: 4096, reason: 'spill', weightsExceedVram: true })
  })
})

describe('fitAfterOutOfMemory', () => {
  it('halves down to the floor, then gives up', () => {
    expect(fitAfterOutOfMemory(131072, 131072)).toEqual({ window: 65536, reason: 'out-of-memory' })
    expect(fitAfterOutOfMemory(32768, 12288)).toEqual({ window: MIN_FIT_WINDOW, reason: 'out-of-memory' })
    expect(fitAfterOutOfMemory(32768, MIN_FIT_WINDOW)).toBeNull()
    expect(fitAfterOutOfMemory(4096, 4096)).toBeNull()
  })
})

describe('planWindowForBudget', () => {
  const perToken = 98304
  const loaded = { window: 32768, sizeBytes: 19 * GIB + 32768 * perToken }

  it('fills the budget left after weights, reserves and per-GPU overhead', () => {
    const planned = planWindowForBudget({
      requested: 262144,
      maxContext: 262144,
      ...loaded,
      bytesPerToken: perToken,
      budgetBytes: 30 * GIB,
      gpuCount: 3
    })!
    const usable = 30 * GIB * (1 - PLAN_RESERVE_SHARE) - 3 * PER_GPU_RESERVE_BYTES - 19 * GIB
    expect(planned).toBe(Math.floor(usable / perToken / FIT_STEP_TOKENS) * FIT_STEP_TOKENS)
    expect(planned).toBeGreaterThan(loaded.window)
    expect(19 * GIB + planned * perToken).toBeLessThanOrEqual(30 * GIB)
  })

  it('never exceeds the model maximum', () => {
    expect(
      planWindowForBudget({
        requested: 40960,
        maxContext: 40960,
        ...loaded,
        bytesPerToken: perToken,
        budgetBytes: 80 * GIB,
        gpuCount: 1
      })
    ).toBe(40960)
  })

  it('returns null when it cannot support a plan', () => {
    const base = { requested: 262144, maxContext: 262144, ...loaded, gpuCount: 1 }
    expect(planWindowForBudget({ ...base, bytesPerToken: null, budgetBytes: 30 * GIB })).toBeNull()
    expect(planWindowForBudget({ ...base, bytesPerToken: perToken, budgetBytes: 0 })).toBeNull()
    expect(planWindowForBudget({ ...base, bytesPerToken: perToken, budgetBytes: 16 * GIB })).toBeNull()
    // A cost larger than the measured size means the estimate is wrong for this model.
    expect(
      planWindowForBudget({ ...base, bytesPerToken: 64 * MIB, budgetBytes: 30 * GIB })
    ).toBeNull()
  })
})

describe('isOutOfMemoryError', () => {
  it.each([
    'Model connection failed: HTTP 500 {"error":"model requires more system memory (24.1 GiB) than is available (20.0 GiB)"}',
    'model requires more memory than is available',
    'CUDA error: out of memory',
    'ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory',
    'insufficient memory for KV cache',
    'failed to allocate compute buffers'
  ])('recognises %s', (message) => expect(isOutOfMemoryError(new Error(message))).toBe(true))

  it('ignores other failures', () => {
    expect(isOutOfMemoryError(new Error('HTTP 404 model not found'))).toBe(false)
    expect(isOutOfMemoryError(undefined)).toBe(false)
  })
})

describe('several Ollama servers', () => {
  const conn = (id: string, over: Partial<ModelConnection> = {}): ModelConnection => ({
    id,
    name: id,
    type: 'openai-compatible',
    provider: 'ollama',
    enabled: true,
    baseUrl: `http://127.0.0.1:${id === 'ollama' ? 11434 : 11435}/v1`,
    apiKeyRef: '',
    models: [],
    ...over
  })
  const builtin: ModelConnection = { ...conn('builtin'), type: 'builtin', provider: 'builtin' }
  const cloud = conn('eris-cloud', { baseUrl: 'https://agents.ericservic.es/v1' })
  const second = conn('conn-ollama-b', { contextFit: 'max', vramGiB: 6 })

  it('picks id ollama as the primary, else the first local server, never Eris Cloud', () => {
    expect(primaryOllamaConnection([second, conn('ollama')])?.id).toBe('ollama')
    expect(primaryOllamaConnection([cloud, second])?.id).toBe('conn-ollama-b')
    expect(primaryOllamaConnection([cloud])).toBeUndefined()
  })

  it('saving the primary keeps every other server', () => {
    const before = [builtin, conn('ollama'), second, cloud]
    const after = withPrimaryOllama(before, 'ollama', conn('ollama', { baseUrl: 'http://10.0.0.2:11434/v1' }))
    expect(after.map((c) => c.id)).toEqual(['builtin', 'ollama', 'conn-ollama-b', 'eris-cloud'])
    expect(after.find((c) => c.id === 'conn-ollama-b')).toBe(second)
    expect(withPrimaryOllama(before, 'ollama', null).map((c) => c.id)).toEqual([
      'builtin',
      'conn-ollama-b',
      'eris-cloud'
    ])
  })

  it('creating the first primary replaces nothing else', () => {
    expect(withPrimaryOllama([second], undefined, conn('ollama')).map((c) => c.id)).toEqual([
      'ollama',
      'conn-ollama-b'
    ])
  })

  const draft = (over: Partial<Parameters<typeof connectionFromDraft>[0]> = {}) => ({
    id: second.id,
    name: ' Ollama B ',
    provider: 'ollama',
    enabled: true,
    baseUrl: 'http://127.0.0.1:11435/v1/',
    modelsText: 'qwen3.5:4b, qwen3-embedding:0.6b',
    modelLimits: {},
    recallApproved: false,
    ollama: { contextFit: second.contextFit, vramGiB: second.vramGiB },
    original: { ...second, keepModelLoaded: true },
    ...over
  })

  it('a saved draft keeps fields the editor does not show', () => {
    const saved = connectionFromDraft(draft(), '')
    expect(saved).toMatchObject({
      name: 'Ollama B',
      baseUrl: 'http://127.0.0.1:11435/v1',
      models: ['qwen3.5:4b', 'qwen3-embedding:0.6b'],
      keepModelLoaded: true,
      contextFit: 'max',
      vramGiB: 6
    })
    expect('kvCacheType' in saved).toBe(false)
  })

  it('clears window fields when the editor clears them or the provider is not Ollama', () => {
    expect('vramGiB' in connectionFromDraft(draft({ ollama: { contextFit: 'fit' } }), '')).toBe(false)
    const custom = connectionFromDraft(draft({ provider: 'custom' }), '')
    expect(custom.contextFit).toBeUndefined()
    expect(custom.vramGiB).toBeUndefined()
  })

  it('drops a withdrawn recall approval and a removed reasoning setting', () => {
    const original = {
      ...second,
      baseUrl: 'https://gpu.example.com/v1',
      recallApprovedUrl: 'https://gpu.example.com/v1',
      reasoning: { level: 'high' as const, show: true }
    }
    const saved = connectionFromDraft(
      draft({ baseUrl: original.baseUrl, original, recallApproved: false, reasoning: undefined }),
      ''
    )
    expect(saved.recallApprovedUrl).toBeUndefined()
    expect(saved.reasoning).toBeUndefined()
    const approved = connectionFromDraft(draft({ baseUrl: original.baseUrl, original, recallApproved: true }), '')
    expect(approved.recallApprovedUrl).toBe(original.baseUrl)
  })
})
