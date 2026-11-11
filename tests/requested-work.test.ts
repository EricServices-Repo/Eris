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
  it('keeps a delegated supplied-code review independent of parent workspace tools (#437)', () => {
    const root = workspace()
    const parent = createTaskContract({workspacePath:root,text:'Fix booking.ts',plan:plan()})
    const child = childTaskContract(parent,{...plan('review'),toolPolicy:'read'},
      'Review this code sample:\n```js\nconst sum = (a,b) => a-b\n```',root,'child-review')
    expect(child.scope.applicability).toBe('generic')
    expect(child.requested?.evidence).toBeUndefined()
    expect(child.authority).toMatchObject({tools:'none',edit:false,execute:'none'})
    expect(parsePersistedTask(child).scope.applicability).toBe('generic')
  })
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
  it('rejects the reviewed patch counterexample after a read and passing generic check (#464)', () => {
    const root = workspace()
    writeFileSync(join(root, 'index.ts'), 'export const value = 1\n')
    const compiled = createTaskContract({ workspacePath: root, text: 'Fix index.ts', plan: plan() })
    const task = { ...compiled, requested: { ...compiled.requested!, targetFiles: ['index.ts'] } }
    expect(task.requested).toMatchObject({ artifact: 'patch', destination: 'workspace', targetFiles: ['index.ts'] })
    const workflow = new AgentWorkflow({ ...plan(), task })
    workflow.noteTool({ name: 'read_file', path: 'index.ts', ok: true, mutated: false })
    workflow.noteVerification('passed')
    expect(workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: true, filesTouched: [] }).ok).toBe(false)
    expect(completeChatTurnTask(task, { answer: 'Done', changedFiles: [], terminal: 'complete' }).result?.terminal).toBe('incomplete')
  })
  it('does not claim an inspected existing artifact was implemented in this run (#443)', () => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: 'Create booking.ts', plan: plan() })
    writeFileSync(join(root, 'booking.ts'), 'export const booking = true')
    const workflow = new AgentWorkflow({ ...plan(), task })
    workflow.noteTool({ name: 'read_file', path: 'booking.ts', ok: true, mutated: false })
    expect(workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false }).ok).toBe(false)
    workflow.noteVerification('passed')
    expect(workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false, filesTouched: [] }).ok).toBe(false)
    // Existing code need not be rewritten, but existence plus a generic check is
    // not proof that this requested implementation was delivered.
    workflow.noteTool({ name:'write_file',path:'unrelated.ts',ok:true,mutated:true })
    expect(workflow.evaluateOutcome({workspaceMutated:true,codeMutated:true,verifyPassed:true,filesTouched:['unrelated.ts']}).ok).toBe(false)
    writeFileSync(join(root,'booking.ts'),'export const booking = { confirmed: true }')
    workflow.noteTool({name:'write_file',path:'booking.ts',ok:true,mutated:true})
    expect(workflow.evaluateOutcome({workspaceMutated:true,codeMutated:true,verifyPassed:true,filesTouched:['booking.ts']}).ok).toBe(true)
  })
  it('requires every generated output to have actual change evidence, not just a read (#443)', () => {
    const root=workspace()
    const task=createTaskContract({workspacePath:root,text:'Create booking.ts and calendar.ts',plan:plan()})
    writeFileSync(join(root,'booking.ts'),'export const booking = true')
    writeFileSync(join(root,'calendar.ts'),'export const calendar = true')
    const workflow=new AgentWorkflow({...plan(),task})
    workflow.noteTool({name:'write_file',path:'booking.ts',ok:true,mutated:true})
    workflow.noteTool({name:'read_file',path:'calendar.ts',ok:true,mutated:false})
    workflow.noteVerification('passed')
    expect(workflow.evaluateOutcome({workspaceMutated:true,codeMutated:true,verifyPassed:true,filesTouched:['booking.ts']}).ok).toBe(false)
    workflow.noteTool({name:'write_file',path:'calendar.ts',ok:true,mutated:true})
    expect(workflow.evaluateOutcome({workspaceMutated:true,codeMutated:true,verifyPassed:true,filesTouched:['booking.ts','calendar.ts']}).ok).toBe(true)
  })
  it('accepts requested code by its parser when the project has no check, and says what was checked (#499)', () => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: 'Create booking.ts and index.php', plan: plan() })
    writeFileSync(join(root, 'booking.ts'), 'export const booking = { confirmed: true }\n')
    writeFileSync(join(root, 'index.php'), '<?php echo "booking"; ?>\n')
    const workflow = new AgentWorkflow({ ...plan(), task })
    workflow.noteTool({ name: 'write_file', path: 'booking.ts', ok: true, mutated: true })
    workflow.noteTool({ name: 'write_file', path: 'index.php', ok: true, mutated: true })
    const outcome = () => workflow.evaluateOutcome({ workspaceMutated: true, codeMutated: true, verifyPassed: false, filesTouched: ['booking.ts', 'index.php'] })
    // Not run yet: the reason names the files and the next step.
    expect(outcome()).toMatchObject({ ok: false, reason: expect.stringContaining('Run the project') })
    workflow.noteVerification('skipped', 'diagnostics')
    expect(outcome()).toMatchObject({ ok: false, reason: expect.stringContaining('checks are disabled') })
    workflow.noteVerification('failed')
    expect(outcome()).toMatchObject({ ok: false, reason: expect.stringContaining('project check failed') })
    for (const reason of ['no-project-check', 'no-tests'] as const) {
      workflow.noteVerification('skipped', reason)
      expect(outcome().ok).toBe(true)
      expect(workflow.verificationNote()).toBe('This project has no test or typecheck script, so only the syntax of booking.ts was checked and index.php was not checked.')
    }
    workflow.noteVerification('passed')
    expect(workflow.evaluateOutcome({ workspaceMutated: true, codeMutated: true, verifyPassed: true, filesTouched: ['booking.ts', 'index.php'] }).ok).toBe(true)
    expect(workflow.verificationNote()).toBeNull()
  })
  it('keeps a syntax error blocking when the project has no check (#499)', () => {
    const root = workspace()
    const task = createTaskContract({ workspacePath: root, text: 'Create booking.ts', plan: plan() })
    writeFileSync(join(root, 'booking.ts'), 'export const booking = {\n')
    const workflow = new AgentWorkflow({ ...plan(), task })
    workflow.noteTool({ name: 'write_file', path: 'booking.ts', ok: true, mutated: true })
    workflow.noteVerification('skipped', 'no-project-check')
    expect(workflow.evaluateOutcome({ workspaceMutated: true, codeMutated: true, verifyPassed: false, filesTouched: ['booking.ts'] }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('booking.ts: syntax errors') })
  })
  it.each(['Delete obsolete.ts','Rename obsolete.ts to renamed.ts'])(
    'retains change evidence for non-creation operations: %s', text => {
      const root=workspace()
      const task=createTaskContract({workspacePath:root,text,plan:plan()})
      const workflow=new AgentWorkflow({...plan(),task})
      workflow.noteTool({name:'delete_file',path:'obsolete.ts',ok:true,mutated:true})
      expect(workflow.evaluateOutcome({workspaceMutated:true,codeMutated:true,verifyPassed:true,filesTouched:['obsolete.ts']}).ok).toBe(true)
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
