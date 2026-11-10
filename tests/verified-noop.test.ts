import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { confirmUnchanged } from '../electron/main/services/agent/verified-noop'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'
import { assessGoalCompletion } from '../electron/main/services/agent/heuristics'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })))
const source =
  'export const check = (x) => {\n  if (x < 0) throw new Error("negative")\n  return x\n}\n'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function ws() {
  const root = mkdtempSync(join(tmpdir(), 'eris-noop-'))
  roots.push(root)
  writeFileSync(join(root, 'check.js'), source)
  return root
}
const args = {
  requirement: 'reject negative input',
  path: 'check.js',
  evidence: 'if (x < 0)   throw new Error("negative")'
}

describe('confirm_unchanged (#457)', () => {
  it('accepts whitespace-normalized verbatim evidence from a fully read, unchanged file', () => {
    const root = ws()
    const result = confirmUnchanged(root, args, () => sha(source))
    expect(result.ok).toBe(true)
    expect(result.noop).toMatchObject({ path: 'check.js', fileDigest: sha(source) })
  })
  it('requires a complete read of the file first', () => {
    expect(confirmUnchanged(ws(), args, () => undefined).detail).toContain('Read the whole')
  })
  it('rejects a file that changed after it was read', () => {
    const root = ws()
    const result = confirmUnchanged(root, args, () => sha('older content'))
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('changed after it was read')
  })
  it('rejects evidence that is absent or too short to be specific', () => {
    const root = ws()
    expect(
      confirmUnchanged(root, { ...args, evidence: 'if (x <= 0) return' }, () => sha(source)).ok
    ).toBe(false)
    expect(confirmUnchanged(root, { ...args, evidence: 'x' }, () => sha(source)).ok).toBe(false)
    expect(confirmUnchanged(root, { ...args, path: '../outside.js' }, () => sha(source)).ok).toBe(
      false
    )
  })
})

const plan = (): TurnPlan => ({
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  toolPolicy: 'edit',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  models: { chat: 'local:test', tools: 'local:test' }
})

describe('outcome disposition', () => {
  function workflow(root: string, text = 'Add negative input validation to check.js') {
    const p = plan()
    p.task = createTaskContract({ workspacePath: root, text, plan: p })
    const flow = new AgentWorkflow(p, text)
    flow.noteTool({ ok: true, mutated: false, name: 'read_file', path: 'check.js', detail: source })
    return flow
  }
  const unchanged = { workspaceMutated: false, codeMutated: false, verifyPassed: false }
  it('still rejects an edit request that changed nothing and confirmed nothing', () => {
    expect(workflow(ws()).evaluateOutcome(unchanged)).toMatchObject({ ok: false })
  })
  it('reports already-satisfied instead of changed for a verified no-op', () => {
    const root = ws()
    const flow = workflow(root)
    flow.noteVerifiedNoop(confirmUnchanged(root, args, () => sha(source)).noop!)
    expect(flow.evaluateOutcome({ ...unchanged, filesTouched: [] })).toEqual({
      ok: true,
      disposition: 'already-satisfied'
    })
  })
  it('drops the confirmation when the confirmed file is later edited', () => {
    const root = ws()
    const flow = workflow(root)
    flow.noteVerifiedNoop(confirmUnchanged(root, args, () => sha(source)).noop!)
    flow.noteTool({ ok: true, mutated: true, name: 'write_file', path: 'check.js' })
    expect(flow.snapshot().verifiedNoops).toBeUndefined()
    expect(flow.evaluateOutcome({ ...unchanged, workspaceMutated: true }).disposition).not.toBe(
      'already-satisfied'
    )
  })
  it('lets the goal check accept a verified no-op but not a bare DONE', () => {
    const base = {
      goal: 'Add validation',
      assistantText: 'DONE: already present',
      actionLog: [],
      filesTouched: [],
      codeMutated: false,
      reviewOnly: false
    }
    expect(assessGoalCompletion(base).unmet).toBe(true)
    expect(assessGoalCompletion({ ...base, verifiedNoop: true }).unmet).toBe(false)
  })
})
