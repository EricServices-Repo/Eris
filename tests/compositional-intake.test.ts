import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import type { TaskContract } from '../src/shared/task-contract'

const root = mkdtempSync(join(tmpdir(), 'eris-compositional-intake-'))
writeFileSync(join(root, 'index.html'), '<main>News</main>')
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function authority(text: string, mode: 'agent' | 'ask' = 'agent', followUp = false) {
  const history = followUp ? [{ role: 'user' as const, content: 'Review the project.' }, { role: 'assistant' as const, content: 'The project could use search.' }] : []
  const result = await captureQuestion(0, text, root, 8192, mode, new AbortController().signal, { question: { history } })
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


describe('composed quoted and follow-up requests (#465)', () => {
  const operations = ['Add', 'Remove'] as const
  const features = ['search', 'the debug banner'] as const
  const conjunctions = ['and', 'then'] as const
  const quotes = ['"Do not edit files"', '"Delete the entire project"'] as const
  const modes = ['agent', 'ask'] as const
  const projects = ['this project', 'the workspace'] as const
  const cases = operations.flatMap((operation) => features.flatMap((feature) =>
    conjunctions.flatMap((conjunction) => quotes.flatMap((quote) => modes.flatMap((mode) =>
      projects.flatMap((project) => [false, true].flatMap((followUp) =>
        [false, true].map((negated) => ({ operation, feature, conjunction, quote, mode, project, followUp, negated }))
      ))
    )))
  ))
  it('covers each operation, feature, conjunction, quoted instruction, mode and negation', () => {
    expect(cases).toHaveLength(256)
    expect(new Set(cases.map((entry) => entry.operation)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.feature)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.conjunction)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.quote)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.mode)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.project)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.followUp)).size).toBe(2)
    expect(new Set(cases.map((entry) => entry.negated)).size).toBe(2)
  })
  it.each(cases)('preserves authority under composition: $operation $feature $conjunction $quote $mode $project follow-up=$followUp no-edit=$negated', async (entry) => {
    const text = `${entry.operation} ${entry.feature} in ${entry.project} ${entry.conjunction} review the project. The customer wrote ${entry.quote}.${entry.negated ? ' Do not edit files.' : ''}`
    expect(await authority(text, entry.mode, entry.followUp), text).toBe(entry.mode === 'agent' && !entry.negated)
  })
  it.each(modes.flatMap((mode) => quotes.map((quote) => ({ mode, quote }))))(
    'does not escalate a read-only request from quoted instructions: $mode $quote',
    async ({ mode, quote }) => {
      const text = `Review this project and recommend improvements. The customer wrote ${quote}.`
      expect(await authority(text, mode, true), text).toBe(false)
    }
  )
  it.each(['Add search', 'Remove the debug banner'])('preserves explicit edit and negation on follow-up: %s', async (text) => {
    const history = [
      { role: 'user' as const, content: 'Review this project.' },
      { role: 'assistant' as const, content: 'I recommend adding search and removing the debug banner.' }
    ]
    for (const negated of [false, true]) {
      const request = `${text}${negated ? ', but do not edit files' : ''}`
      const result = await captureQuestion(0, request, root, 8192, 'agent', new AbortController().signal, { question: { history } })
      expect((result.task as TaskContract).authority.edit, request).toBe(!negated)
    }
  })
})
