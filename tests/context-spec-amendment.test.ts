import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const doc = (name: string) => readFileSync(join(__dirname, '..', 'docs', name), 'utf8')
const amendment = doc('RAM-CONTEXT-AMENDMENT-001.md')
const sections = new Set(amendment.match(/^## (A\d+)\./gm)?.map((line) => line.slice(3, -1)))

describe('context specification amendment', () => {
  it('maps every RAM-CTX review ID to a section that exists', () => {
    for (let id = 43; id <= 66; id++) {
      const row = amendment.match(new RegExp(`^\\| RAM-CTX-0${id} \\| #\\d+ \\| (.+) \\|$`, 'm'))
      expect(row, `RAM-CTX-0${id}`).not.toBeNull()
      for (const ref of row![1]!.match(/\bA\d+\b/g) ?? []) expect(sections).toContain(ref)
    }
  })

  it('states the context-window and unified-memory limits plainly', () => {
    expect(amendment).toContain('RAM does not enlarge that window')
    expect(amendment).toContain('RAM makes content retrievable, not simultaneously visible')
    expect(amendment).toContain('RAM and VRAM are one physical pool')
  })

  it('adds the recoverable-eviction invariant', () => {
    expect(amendment).toMatch(
      /no tool result is evicted without a recoverable handle or an explicit omission marker/
    )
  })

  it('is linked from the spec, and the current-state doc separates target from implemented', () => {
    expect(doc('RAM-CONTEXT-ARCHITECTURE.md')).toContain('RAM-CONTEXT-AMENDMENT-001.md')
    const current = doc('CONTEXT-MEMORY.md')
    expect(current).toContain('RAM-CONTEXT-AMENDMENT-001.md')
    expect(current).toMatch(/\| Area \| Implemented \| Target/)
  })
})
