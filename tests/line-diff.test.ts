import { describe, expect, it } from 'vitest'
import { lineChanges } from '../src/shared/line-diff'

describe('lineChanges', () => {
  it('reports an inserted and a deleted line', () => {
    const changes = lineChanges('a\nb\nc', 'a\nB\nc')
    expect(changes).toEqual([
      { kind: 'insert', oldLine: 1, lines: ['B'] },
      { kind: 'delete', oldLine: 2, lines: ['b'] }
    ])
  })

  it('groups a new file as one insert', () => {
    const changes = lineChanges('', 'one\ntwo')
    expect(changes.some((change) => change.kind === 'insert' && change.lines.join('\n') === 'one\ntwo')).toBe(
      true
    )
  })
})
