import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import { prepareQuestions } from '../electron/dev/questions'
import type { DevResult } from '../src/shared/eris-dev'

/**
 * FR-037: the full 10,000-question corpus through the production request boundary
 * (captureQuestion: routing, resolver, task contract, prompt compilation and tool
 * exposure), with a scripted zero-confidence resolver. This is pre-inference
 * evidence only: no model answers, tool execution or answer quality.
 */
const corpus = prepareQuestions(
  readFileSync(join(__dirname, 'fixtures', '10000-natural-diverse-coding-questions.txt'), 'utf8'),
  '.txt'
)

type Row = Pick<DevResult, 'status' | 'intent' | 'artifact' | 'findingIds'> & {
  source: string
  authority: string
  contextChars: number
  reason?: string
}

let workspace = ''
const rows: Row[] = []
const tally = (key: (row: Row) => string) =>
  rows.reduce<Record<string, number>>((out, row) => {
    const value = key(row)
    out[value] = (out[value] ?? 0) + 1
    return out
  }, {})

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'eris-corpus-boundary-'))
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture' }))
  writeFileSync(join(workspace, 'index.js'), 'export function divide(a, b) { return a / b }\n')
  for (const [index, question] of corpus.questions.entries()) {
    const result = await captureQuestion(
      index,
      question.text,
      workspace,
      8192,
      'agent',
      new AbortController().signal,
      { question }
    )
    const task = result.task as
      | {
          authority?: { tools: string; edit: boolean; execute: string }
          interpretation?: { resolution?: { source: string } }
        }
      | undefined
    const agent = result.requests.find((request) => request.purpose === 'agent')
    rows.push({
      status: result.status,
      intent: result.intent,
      artifact: result.artifact,
      findingIds: result.findingIds,
      source: task?.interpretation?.resolution?.source ?? 'none',
      authority: task?.authority
        ? `${task.authority.tools}/edit:${task.authority.edit}/execute:${task.authority.execute}`
        : 'none',
      contextChars: JSON.stringify(agent?.messages ?? []).length,
      ...(result.status === 'captured' ? {} : { reason: result.detail ?? 'no detail' })
    })
  }
  // Persist the distribution so a run can be compared with the next one.
  const out = join(__dirname, '..', 'out', 'qualification')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'corpus-boundary.json'),
    JSON.stringify(
      {
        timing: 'pre-inference',
        total: rows.length,
        byStatus: tally((row) => row.status),
        byIntent: tally((row) => row.intent ?? 'none'),
        byArtifact: tally((row) => row.artifact ?? 'none'),
        byAuthority: tally((row) => row.authority),
        byResolverSource: tally((row) => row.source),
        byFinding: rows
          .flatMap((row) => row.findingIds)
          .reduce<Record<string, number>>((acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }), {}),
        contextChars: {
          max: Math.max(...rows.map((row) => row.contextChars)),
          mean: Math.round(rows.reduce((sum, row) => sum + row.contextChars, 0) / rows.length)
        }
      },
      null,
      2
    ) + '\n'
  )
}, 300_000)
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('full corpus at the production request boundary', () => {
  it('every case reaches the boundary or records why not; totals are exact', () => {
    expect(rows).toHaveLength(10000)
    expect(rows.filter((row) => row.status !== 'captured' && !row.reason)).toEqual([])
    expect(Object.values(tally((row) => row.status)).reduce((a, b) => a + b, 0)).toBe(10000)
    expect(tally((row) => row.status)).toEqual({ captured: 10000 })
  })

  it('no corpus question is given edit or run authority without a semantic decision', () => {
    expect(rows.filter((row) => row.intent === 'edit' || row.intent === 'run')).toEqual([])
    expect(rows.filter((row) => row.authority.includes('edit:true'))).toEqual([])
  })

  it('no request has an invariant defect', () => {
    const defects = rows.filter((row) =>
      row.findingIds.some((id) =>
        [
          'contract-conflict',
          'answer-requires-mutation',
          'domain-model-as-capability',
          'missing-task-contract',
          'tool-free-mutation-plan',
          'recommendations-truncated',
          'forbidden-edit-granted',
          'forbidden-run-granted',
          // LR-017: scope and artifact loss found by the 2026-10-23 review.
          'generic-requires-project-evidence',
          'explicit-example-without-implementation',
          'output-cardinality-loss',
          'read-only-findings-format'
        ].includes(id)
      )
    )
    expect(defects).toEqual([])
  })

  it('every case records its resolver source', () => {
    expect(rows.filter((row) => row.source === 'none')).toEqual([])
  })
})
