import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import type { TaskContract } from '../src/shared/task-contract'

const root = mkdtempSync(join(tmpdir(), 'eris-compositional-intake-'))
writeFileSync(join(root, 'index.html'), '<main>News</main>')
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function authority(text: string, mode: 'agent' | 'ask' = 'agent') {
  const result = await captureQuestion(0, text, root, 8192, mode, new AbortController().signal)
  return (result.task as TaskContract).authority.edit
}

describe('compositional intake authority (issue 465)', () => {
  // Cross product: operation × feature × politeness × UI mode.
  for (const operation of ['Add', 'Remove']) {
    for (const feature of ['search', 'the debug banner']) {
      for (const polite of ['', 'Please ']) {
        const text = `${polite}${operation.toLowerCase()} ${feature}`
        it(`preserves mode ceiling: ${text}`, async () => {
          expect(await authority(text, 'agent'), text).toBe(true)
          expect(await authority(text, 'ask'), text).toBe(false)
        })
      }
    }
  }

  // Cross product: conjunction × requested edit, with a read-only counterpart.
  for (const conjunction of ['and', 'then']) {
    for (const action of ['improve the layout', 'remove the debug banner']) {
      const text = `Review the files ${conjunction} ${action}`
      it(`keeps the edit and respects negation: ${text}`, async () => {
        expect(await authority(text), text).toBe(true)
        expect(await authority(`${text} but do not edit files`), text).toBe(false)
      })
    }
  }

  it.each([
    'Review the files and recommend improvements',
    'What is the best way to add search?',
    '"Add search"'
  ])('does not grant write authority for %s', async text => {
    expect(await authority(text), text).toBe(false)
  })

  it.each(['Add search', 'Add pagination'])('requires a destination for %s', async text => {
    const result = await captureQuestion(0, text, null, 8192, 'agent', new AbortController().signal)
    expect(result.requests.filter(request => request.purpose === 'agent')).toHaveLength(0)
    expect((result.task as TaskContract).requested?.artifact).toBe('patch')
  })

  it('keeps an explicit no-edit instruction with prior chat context', async () => {
    const result = await captureQuestion(0, 'Add search but do not edit files', root, 8192,
      'agent', new AbortController().signal, {
        question: { history: [
          { role: 'user', content: 'Please review the files.' },
          { role: 'assistant', content: 'The project could use search.' }
        ] }
      })
    expect((result.task as TaskContract).authority.edit).toBe(false)
  })
})
