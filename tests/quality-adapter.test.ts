import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { productionQualityAdapter } from '../electron/dev/quality-adapter'
import { captureSettings } from '../electron/dev/capture'
import type { DevResult } from '../src/shared/eris-dev'
import type { QualityCase } from '../src/shared/quality'
import { QualityInputSchema } from '../electron/dev/quality-runs'
const test: QualityCase = {
  id: 'fixture',
  stratum: 'patch',
  project: { 'counter.js': 'before' },
  prompt: 'Fix counter',
  obligations: ['fix'],
  oracle: 'human'
}
const signal = () => new AbortController().signal
describe('supported production quality adapter', () => {
  it('passes real production-capture inputs/limits and exports redacted evidence', async () => {
    let root: string | null = null
    const settings = captureSettings(8192)
    settings.models.connections = [
      {
        id: 'provider',
        name: 'test',
        provider: 'custom',
        type: 'openai-compatible',
        enabled: true,
        baseUrl: 'http://localhost:1234',
        apiKeyRef: 'key',
        models: ['test']
      }
    ]
    const adapter = productionQualityAdapter(8192, {
      prepare: async () => ({
        settings,
        model: 'test',
        getSecret: () => 'private-custom-credential',
        digest: 'settings'
      }),
      capture: async (index, prompt, workspace, context, mode, _signal, options) => {
        root = workspace
        expect(readFileSync(join(workspace!, 'counter.js'), 'utf8')).toBe('before')
        expect(prompt).toBe(test.prompt)
        expect(context).toBe(8192)
        expect(mode).toBe('agent')
        expect(options?.maxCalls).toBe(6)
        expect(options?.maxOutputTokens).toBe(100)
        writeFileSync(join(workspace!, 'counter.js'), 'after')
        return {
          response: 'private-custom-credential',
          completion: { status: 'completed' },
          requests: [{ messages: [{ role: 'user', content: 'private-custom-credential' }] }],
          events: ['Blocked command: npm test'],
          inference: { calls: 2 }
        } as unknown as DevResult
      }
    })
    const result = await adapter.run({
      test,
      model: 'model-id',
      repeat: 0,
      maxCalls: 6,
      maxOutputTokens: 600,
      signal: signal()
    })
    expect(result.completion).toBe('complete')
    expect(result.calls).toBe(2)
    expect(JSON.stringify(result)).not.toContain('private-custom-credential')
    expect(JSON.stringify(result)).not.toContain(root!)
    expect(result.observed?.files).toEqual({ 'counter.js': 'after' })
    expect(existsSync(root!)).toBe(false)
  })
  it('refuses traversal fixtures before preparing a model', async () => {
    let prepared = false
    const adapter = productionQualityAdapter(8192, {
      prepare: async () => {
        prepared = true
        throw new Error('must not run')
      },
      capture: async () => {
        throw new Error('must not run')
      }
    })
    await expect(
      adapter.run({
        test: { ...test, project: { '../escape.js': 'unsafe' } },
        model: 'test',
        repeat: 0,
        maxCalls: 6,
        maxOutputTokens: 600,
        signal: signal()
      })
    ).rejects.toThrow(/setup/)
    expect(prepared).toBe(false)
  })
  it('does not turn unsupported recovery faults into successful quality evidence', async () => {
    const adapter = productionQualityAdapter(8192)
    const result = await adapter.run({
      test: { ...test, fault: 'provider-timeout' },
      model: 'unused',
      repeat: 0,
      maxCalls: 6,
      maxOutputTokens: 600,
      signal: signal()
    })
    expect(result.completion).toBe('not-exercised')
    expect(result.calls).toBe(0)
  })
  it('requires explicit live opt-in, finite budgets and a real model selection', () => {
    expect(
      QualityInputSchema.safeParse({
        models: ['test'],
        context: 8192,
        repeats: 1,
        maxCalls: 6,
        maxOutputTokens: 4096,
        live: true
      }).success
    ).toBe(true)
    expect(
      QualityInputSchema.safeParse({
        models: [],
        context: 8192,
        repeats: 1,
        maxCalls: 6,
        maxOutputTokens: 4096,
        live: false
      }).success
    ).toBe(false)
  })
})
