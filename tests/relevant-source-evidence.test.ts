import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'
import { createTaskContract } from '../electron/main/services/task-intake'
import { noteEvidenceChange } from '../electron/main/services/context-evidence-epochs'
import type { TurnPlan } from '../src/shared/settings-schema'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(text = 'Review the booking flow') {
  const root = mkdtempSync(join(tmpdir(), 'eris-source-proof-'))
  roots.push(root)
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write('calculator.ts', 'export const add = (a:number,b:number) => a+b')
  write('booking.ts', 'export const book = () => "confirmed"')
  const plan: TurnPlan = {
    intent: 'review',
    agentId: 'reviewer',
    agentName: 'Reviewer',
    mode: 'agent',
    toolPolicy: 'read',
    models: { chat: 'simulated:review', tools: 'simulated:review' },
    requiresTools: true,
    escalateToFull: false,
    method: 'heuristic',
    reason: 'test'
  }
  const task = createTaskContract({ workspacePath: root, text, plan })
  const workflow = new AgentWorkflow({ ...plan, task })
  const read = (path: string) =>
    workflow.noteTool({
      ok: true,
      mutated: false,
      name: 'read_file',
      path,
      detail: readFileSync(join(root, path), 'utf8')
    })
  const assess = () =>
    workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false })
  return { root, write, read, assess, workflow, task }
}
describe('relevant fresh source evidence (#444)', () => {
  it('accepts an inspected empty target as evidence of missing implementation', () => {
    const f = fixture('Review booking.ts')
    f.write('booking.ts', '')
    f.read('booking.ts')
    expect(f.assess().ok).toBe(true)
    expect(f.workflow.snapshot().sourceEvidence?.[0]?.digest).toMatch(/^[a-f0-9]{64}$/)
  })
  it('rejects an unrelated calculator read for a booking review', () => {
    const f = fixture()
    f.read('calculator.ts')
    expect(f.assess().ok).toBe(false)
    f.write('README.md', '# Generic fixture for routing and response tests')
    f.read('README.md')
    expect(f.assess().ok).toBe(false)
    f.read('booking.ts')
    expect(f.assess().ok).toBe(true)
    expect(
      f.workflow.snapshot().sourceEvidence?.find((entry) => entry.path === 'booking.ts')
    ).toMatchObject({ requirementIds: ['task-source'] })
  })
  it('requires an exact target identity rather than a same-basename file', () => {
    const f = fixture('Review booking.ts')
    f.write('other/booking.ts', 'export const book = true')
    f.read('other/booking.ts')
    expect(f.assess().ok).toBe(false)
    f.read('booking.ts')
    expect(f.assess().ok).toBe(true)
  })
  it('records a bounded router-to-handler discovery chain with hashes and ranges', () => {
    const f = fixture()
    f.write(
      'router.ts',
      'import { handle } from "./handlers/rental"; export const bookingRoute = handle'
    )
    f.write('handlers/rental.ts', 'export const handle = () => "available"')
    f.read('router.ts')
    f.workflow.noteTool({
      ok: true,
      mutated: false,
      name: 'read_file',
      path: 'handlers/rental.ts',
      detail: readFileSync(join(f.root, 'handlers/rental.ts'), 'utf8'),
      range: { startLine: 1, endLine: 1 }
    })
    expect(f.assess().ok).toBe(true)
    const receipt = f.workflow
      .snapshot()
      .sourceEvidence?.find((entry) => entry.path === 'handlers/rental.ts')
    expect(receipt).toMatchObject({
      followedFrom: 'router.ts',
      range: { startLine: 1, endLine: 1 }
    })
    expect(receipt?.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt?.requirementIds).toContain('task-source')
  })
  it('invalidates external changes and dirty source until a fresh eligible read', () => {
    const f = fixture('Review booking.ts')
    f.read('booking.ts')
    expect(f.assess().ok).toBe(true)
    f.write('booking.ts', 'export const book = () => "changed externally"')
    expect(f.assess().ok).toBe(false)
    noteEvidenceChange(f.root, 'booking.ts', true)
    f.read('booking.ts')
    expect(f.assess().ok).toBe(false)
    noteEvidenceChange(f.root, 'booking.ts', false)
    f.read('booking.ts')
    expect(f.assess().ok).toBe(true)
  })
  it('rejects failed, generated-state and wrong-project reads', () => {
    const f = fixture()
    f.write('.eris/booking.ts', 'export const booking = true')
    f.workflow.noteTool({ ok: false, mutated: false, name: 'read_file', path: 'booking.ts' })
    f.read('.eris/booking.ts')
    expect(f.assess().ok).toBe(false)
    const other = fixture()
    f.workflow.noteTool({
      ok: true,
      mutated: false,
      name: 'read_file',
      path: join(other.root, 'booking.ts'),
      detail: 'booking source'
    })
    expect(f.assess().ok).toBe(false)
  })
  it('keeps read-before-edit lineage for a host-observed mutation, but not later external edits', () => {
    const f = fixture('Review the files and fix booking.ts')
    f.read('booking.ts')
    f.write('booking.ts', 'export const book = () => "fixed"')
    f.workflow.noteTool({ ok: true, mutated: true, name: 'write_file', path: 'booking.ts' })
    const receipt = f.workflow
      .snapshot()
      .sourceEvidence?.find((entry) => entry.path === 'booking.ts')
    expect(receipt?.supersededByMutation).toBe(true)
    f.write('booking.ts', 'export const book = () => "external"')
    expect(f.workflow.snapshot().sourceEvidence).toHaveLength(0)
  })
  it('tracks renamed source and invalidates changes to its destination', () => {
    const f = fixture('Review booking.ts')
    f.read('booking.ts')
    renameSync(join(f.root, 'booking.ts'), join(f.root, 'calendar.ts'))
    f.workflow.noteTool({
      ok: true,
      mutated: true,
      name: 'rename_path',
      previousPath: 'booking.ts',
      path: 'calendar.ts'
    })
    expect(f.assess().ok).toBe(true)
    expect(f.workflow.snapshot().sourceEvidence?.[0]?.movedTo).toBe('calendar.ts')
    f.write('calendar.ts', 'export const externallyChanged = true')
    expect(f.assess().ok).toBe(false)
  })
  it('reports a bounded review instead of silently omitting requested targets', () => {
    const f = fixture(
      'Review ' + Array.from({ length: 65 }, (_, index) => `file${index}.ts`).join(', ')
    )
    f.read('calculator.ts')
    expect(f.assess()).toMatchObject({ ok: false, reason: expect.stringContaining('64-target') })
  })
})
