import { describe, expect, it } from 'vitest'
import {
  summarizeThinkingSteps,
  thinkingPreviewLine
} from '../src/features/chat/thinking-summary'

describe('summarizeThinkingSteps', () => {
  it('keeps status and tool breadcrumbs, drops duplicate noise', () => {
    const raw = `
Routing to Cloud Composer…
— Escalating tools to Composer Full…
[ok] read_file src/App.tsx: huge dump of file contents that should not appear
[ok] read_file src/App.tsx
[ok] write_file src/App.tsx
…
thinking…
`
    const steps = summarizeThinkingSteps(raw)
    expect(steps.some((s) => /Escalat/i.test(s))).toBe(true)
    expect(steps.some((s) => /read_file.*App/.test(s))).toBe(true)
    expect(steps.some((s) => /huge dump/i.test(s))).toBe(false)
    expect(steps.length).toBeLessThanOrEqual(8)
  })

  it('falls back to short prose when no breadcrumbs exist', () => {
    const steps = summarizeThinkingSteps('Looking at the router next.\nThen patching the panel.')
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.join(' ')).toMatch(/router|panel/i)
  })
})

describe('thinkingPreviewLine', () => {
  it('prefers a running tool, then status, then last step', () => {
    expect(
      thinkingPreviewLine('— done', null, [
        { name: 'read_file', path: 'a.ts', status: 'running' }
      ])
    ).toBe('read_file a.ts')
    expect(thinkingPreviewLine('— done', 'Composer · edit…', [])).toBe('Composer · edit…')
    expect(thinkingPreviewLine('— Applied 2 files\n', null, [])).toMatch(/Applied 2/)
  })

  it('prefers a concrete step over generic Working… status', () => {
    expect(thinkingPreviewLine('— Reading App.tsx\n', 'Working…', [])).toMatch(/Reading/)
  })

  it('falls back to a thinking tail when there are no breadcrumbs', () => {
    const preview = thinkingPreviewLine(
      'Inspecting the router and preparing a patch for LocalModelsPanel.',
      null,
      []
    )
    expect(preview.length).toBeGreaterThan(8)
    expect(preview).toMatch(/router|LocalModels/i)
  })
})
