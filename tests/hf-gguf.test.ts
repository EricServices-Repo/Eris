import { describe, expect, it } from 'vitest'
import {
  HF_GGUF_BROWSE_URL,
  normalizeHfRepoId,
  parseHfGgufFileUrl
} from '../electron/main/services/hf-gguf'
import { entryFromHfFile } from '../electron/main/services/local-model'

describe('hf-gguf helpers', () => {
  it('points browse URL at Hub GGUF library', () => {
    expect(HF_GGUF_BROWSE_URL).toContain('huggingface.co/models')
    expect(HF_GGUF_BROWSE_URL).toContain('library=gguf')
  })

  it('normalizes Hub model URLs and bare repo ids', () => {
    expect(normalizeHfRepoId('bartowski/Qwen2.5-7B-Instruct-GGUF')).toBe(
      'bartowski/Qwen2.5-7B-Instruct-GGUF'
    )
    expect(
      normalizeHfRepoId('https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF')
    ).toBe('bartowski/Qwen2.5-7B-Instruct-GGUF')
    expect(
      normalizeHfRepoId('https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/')
    ).toBe('bartowski/Qwen2.5-7B-Instruct-GGUF')
    expect(normalizeHfRepoId('not a repo')).toBeNull()
  })

  it('parses direct GGUF resolve/blob URLs', () => {
    const parsed = parseHfGgufFileUrl(
      'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf'
    )
    expect(parsed?.repoId).toBe('bartowski/gemma-2-2b-it-GGUF')
    expect(parsed?.filename).toBe('gemma-2-2b-it-Q4_K_M.gguf')
    expect(parsed?.downloadUrl).toContain('/resolve/main/')
  })

  it('builds a local catalog entry from a Hub file pick', () => {
    const entry = entryFromHfFile({
      repoId: 'bartowski/gemma-2-2b-it-GGUF',
      filename: 'gemma-2-2b-it-Q4_K_M.gguf',
      downloadUrl:
        'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
      sizeBytes: 1708582752,
      quant: 'Q4_K_M'
    })
    expect(entry.ref).toMatch(/^local:hf-/)
    expect(entry.family).toBe('Hugging Face')
    expect(entry.filename).toBe('gemma-2-2b-it-Q4_K_M.gguf')
    expect(entry.approxBytes).toBe(1708582752)
  })
})
