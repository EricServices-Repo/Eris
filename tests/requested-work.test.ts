import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveFileRequest } from '../src/shared/file-request'
import { createTaskContract, childTaskContract } from '../electron/main/services/task-intake'
import { parsePersistedTask } from '../electron/main/services/evidence-schemas'
import { requestedFilesProblem } from '../electron/main/services/agent/requested-files'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'
import { completeChatTurnTask } from '../electron/main/services/chat-turn'
import { extractRecommendations } from '../src/shared/recommendations'
import type { TurnPlan } from '../src/shared/settings-schema'
import { taskIntakeBlocked } from '../src/shared/task-contract'

const roots: string[] = []
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'eris-requested-work-'))
  roots.push(root)
  return root
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const plan = (intent: TurnPlan['intent'] = 'edit'): TurnPlan => ({
  intent, agentId: 'coder', agentName: 'Coder', mode: 'agent',
  toolPolicy: intent === 'edit' ? 'edit' : 'none', requiresTools: intent === 'edit',
  models: { chat: 'local:test', tools: 'local:test' }, escalateToFull: false,
  method: 'heuristic', reason: 'test'
})

describe('reference-first file requests', () => {
  it('retains proposed files in the existing durable recommendation representation', () => {
    const items = extractRecommendations('Create booking.ts and calendar.ts for the booking flow.')
    expect(items.flatMap(item => item.targets ?? [])).toEqual(['booking.ts', 'calendar.ts'])
  })
  it.each([
    'Generate those files here in the project', 'Please create those files.',
    'Could you please write these files in this workspace?'
  ])('binds %s without a model', text => {
    expect(resolveFileRequest(text, [{ role: 'assistant', content: 'Create index.php and calendar.php.' }]))
      .toEqual({ state: 'resolved', paths: ['calendar.php', 'index.php'] })
  })
  it.each([
    'How would you generate those files?', 'Generate those files but do not edit anything',
    '"Generate those files"', 'Write index.php as an example in chat'
  ])('does not authorize an example or forbidden operation: %s', text => {
    expect(resolveFileRequest(text)).toBeNull()
  })
  it('does not choose between competing lists or resurrect an unavailable binding', () => {
    const history = [{ role: 'assistant', content: 'Create index.php.' }, { role: 'assistant', content: 'Create calendar.php.' }]
    expect(resolveFileRequest('Generate those files', history)?.state).toBe('ambiguous')
    expect(resolveFileRequest('Generate those files', history, { status: 'unavailable', paths: [] })?.state).toBe('missing')
    expect(resolveFileRequest('Generate those files', history, { status: 'bound', paths: ['register.php'] }))
      .toEqual({ state: 'resolved', paths: ['register.php'] })
  })
})

describe('requested outcomes and execution authority', () => {
  it('persists requested edits in Ask mode without granting edit authority', () => {
    const task = createTaskContract({ workspacePath: workspace(), text: 'Create booking.ts', plan: { ...plan(), mode: 'ask', toolPolicy: 'read' } })
    expect(task.requested).toMatchObject({ artifact: 'patch', destination: 'workspace', targetFiles: ['booking.ts'] })
    expect(task.authority.edit).toBe(false)
    expect(taskIntakeBlocked(task, 'ask')).toBe(false)
    expect(taskIntakeBlocked(task, 'agent')).toBe(true)
    expect(parsePersistedTask(task).requested).toEqual(task.requested)
    expect(completeChatTurnTask(task, { answer: 'Here is the suggested code.', changedFiles: [], terminal: 'complete' }).result?.terminal).toBe('incomplete')
    const { requested: _requested, ...legacy } = task
    expect(parsePersistedTask(legacy).requested).toBeUndefined()
    expect(new AgentWorkflow({ ...plan(), task }).evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false }).ok).toBe(false)
  })
  it('blocks unresolved files and keeps a child explanation separate from a parent patch', () => {
    const root = workspace()
    const unresolved = createTaskContract({ workspacePath: root, text: 'Generate those files here', plan: plan() })
    expect(unresolved.requested?.state).toBe('needs-reference')
    expect(taskIntakeBlocked(unresolved, 'agent')).toBe(true)
    expect(unresolved.authority).toMatchObject({ edit: false, execute: 'none' })
    const parent = createTaskContract({ workspacePath: root, text: 'Create booking.ts', plan: plan() })
    const child = childTaskContract(parent, plan('answer'), 'Explain the date validation approach', root, 'child')
    expect(child.requested).toMatchObject({ artifact: 'explanation', targetFiles: [], destination: 'chat' })
    expect(child.authority.edit).toBe(false)
  })
})

describe('file-set completion evidence', () => {
  it('does not force gratuitous writes to requested files already inspected and present', () => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: 'Create booking.ts', plan: plan() })
    writeFileSync(join(root, 'booking.ts'), 'export const booking = true')
    const workflow = new AgentWorkflow({ ...plan(), task })
    workflow.noteTool({ name: 'read_file', path: 'booking.ts', ok: true, mutated: false })
    expect(workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false }).ok).toBe(false)
    workflow.noteVerification('passed')
    expect(workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false, filesTouched: [] }).ok).toBe(true)
  })
  it.each([
    ['booking.ts', '// TODO: implement booking'],
    ['booking.ts', 'export const booking = '],
    ['booking.json', '{"bookings":'],
    ['booking.php', '<?php\n// TODO: implementation\n?>']
  ])('rejects an inspected placeholder or broken artifact: %s', (path, content) => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: `Create ${path}`, plan: plan() })
    writeFileSync(join(root, path), content)
    expect(requestedFilesProblem(task, [path])).toContain('failed validation')
    const workflow = new AgentWorkflow({ ...plan(), task })
    workflow.noteTool({ name: 'read_file', path, ok: true, mutated: false })
    workflow.noteVerification('passed')
    expect(workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: true }).ok).toBe(false)
  })
  it('requires every output and rejects a same-basename file from another directory', () => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: 'Create booking.ts and calendar.ts', plan: plan() })
    writeFileSync(join(root, 'booking.ts'), 'export const booking = true')
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other/calendar.ts'), 'export const unrelated = true')
    expect(requestedFilesProblem(task, ['booking.ts', 'other/calendar.ts'])).toContain('calendar.ts')
    writeFileSync(join(root, 'calendar.ts'), '')
    expect(requestedFilesProblem(task, ['booking.ts', 'calendar.ts'])).toContain('calendar.ts')
    writeFileSync(join(root, 'calendar.ts'), 'export const calendar = true')
    expect(requestedFilesProblem(task, ['booking.ts'])).toContain('calendar.ts')
    expect(requestedFilesProblem(task, ['booking.ts', 'calendar.ts'])).toBeNull()
  })
  it('does not count a file that was subsequently removed', () => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: 'Create booking.ts', plan: plan() })
    writeFileSync(join(root, 'booking.ts'), 'export const booking = true')
    expect(requestedFilesProblem(task, ['booking.ts'])).toBeNull()
    rmSync(join(root, 'booking.ts'))
    expect(requestedFilesProblem(task, ['booking.ts'])).toContain('booking.ts')
  })
})
