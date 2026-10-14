import { describe, expect, it } from 'vitest'
import {
  OLLAMA_LIBRARY,
  formatOllamaUnreachableError,
  isOllamaModelInstalled,
  normalizeOllamaModelRef,
  ollamaNativeHost,
  resolveInstalledOllamaName
} from '../electron/main/services/ollama'

describe('ollama service', () => {
  it('derives the native API host from an OpenAI-compatible /v1 base URL', () => {
    expect(ollamaNativeHost('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(ollamaNativeHost('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434')
    expect(ollamaNativeHost('http://box.local:11434')).toBe('http://box.local:11434')
  })

  it('falls back to the default host when none is given', () => {
    expect(ollamaNativeHost(undefined)).toBe('http://127.0.0.1:11434')
    expect(ollamaNativeHost('')).toBe('http://127.0.0.1:11434')
  })

  it('ships a curated library including qwen3.8 and pullable names', () => {
    expect(OLLAMA_LIBRARY.length).toBeGreaterThanOrEqual(10)
    for (const e of OLLAMA_LIBRARY) {
      expect(e.name).toMatch(/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/)
      expect(e.label).toBeTruthy()
      expect(e.size).toBeTruthy()
      expect(e.family).toBeTruthy()
    }
    expect(OLLAMA_LIBRARY.some((e) => e.name === 'qwen3.8')).toBe(true)
    expect(OLLAMA_LIBRARY.some((e) => e.name.startsWith('qwen2.5-coder'))).toBe(true)
  })

  it('normalizes library URLs and pull commands to model names', () => {
    expect(normalizeOllamaModelRef('https://ollama.com/library/qwen3.8')).toBe('qwen3.8')
    expect(normalizeOllamaModelRef('https://ollama.com/library/qwen3.8:27b')).toBe('qwen3.8:27b')
    expect(normalizeOllamaModelRef('ollama pull qwen3.8')).toBe('qwen3.8')
    expect(normalizeOllamaModelRef('  qwen2.5-coder:7b  ')).toBe('qwen2.5-coder:7b')
  })

  it('matches installed tags including :latest', () => {
    const installed = ['qwen3.8:latest', 'qwen2.5-coder:7b']
    expect(isOllamaModelInstalled('qwen3.8', installed)).toBe(true)
    expect(isOllamaModelInstalled('qwen3.8:latest', installed)).toBe(true)
    expect(isOllamaModelInstalled('qwen2.5-coder:7b', installed)).toBe(true)
    expect(isOllamaModelInstalled('llama3.1:8b', installed)).toBe(false)
    expect(resolveInstalledOllamaName('qwen3.8', installed)).toBe('qwen3.8:latest')
  })

  it('rewrites opaque fetch failed into an actionable Ollama offline message', () => {
    const err = formatOllamaUnreachableError(
      'http://127.0.0.1:11434',
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    )
    expect(err.message).toMatch(/Can't reach Ollama/)
    expect(err.message).toMatch(/ollama serve/)
    expect(err.message).not.toBe('fetch failed')
  })
})
