import { describe, expect, it } from 'vitest'
import { diffLineStats, languageFromPath } from '../src/shared/diff-stats'

describe('diffLineStats', () => {
  it('counts pure additions', () => {
    expect(diffLineStats('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 })
  })

  it('counts pure removals', () => {
    expect(diffLineStats('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 })
  })

  it('counts replacements', () => {
    expect(diffLineStats('hello', 'world')).toEqual({ added: 1, removed: 1 })
  })

  it('handles empty before (new file)', () => {
    expect(diffLineStats('', 'one\ntwo')).toEqual({ added: 2, removed: 0 })
  })
})

describe('languageFromPath', () => {
  it('maps common extensions', () => {
    expect(languageFromPath('src/App.tsx')).toBe('typescript')
    expect(languageFromPath('a.py')).toBe('python')
  })

  it('uses the rename left path', () => {
    expect(languageFromPath('old.ts → new.ts')).toBe('typescript')
  })
})
