import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import { classifyIntent } from '../electron/main/services/chat-router'
import type { TaskContract } from '../src/shared/task-contract'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'

const roots: string[]=[]
function fixture(files: Record<string,string>) {
  const root=mkdtempSync(join(tmpdir(),'eris-intake-regression-'))
  roots.push(root)
  for(const [name,content] of Object.entries(files)) writeFileSync(join(root,name),content)
  return root
}
afterAll(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})))

describe('issue 436 combined inspection and implementation', () => {
  it.each(['and improve the layout', 'then refactor booking.php', 'and remove the debug banner',
    'and delete the obsolete page', 'then rename the component', '; please optimize the search',
    'and could you please also enhance the layout', '. Also replace the banner'])(
    'retains mutation and source-read obligations for %s', async clause => {
    const text = `Could you please review the files ${clause}`
    expect(classifyIntent(text, 'agent')).toBe('edit')
    const root = fixture({ 'index.html': '<main>Rentals</main>', 'booking.php': '<?php echo "Booking";' })
    const target = text.includes('booking.php') ? 'booking.php' : 'index.html'
    const result = await captureQuestion(0, text, root, 8192, 'agent', new AbortController().signal)
    const task = result.task as TaskContract
    expect(task.requested).toMatchObject({ artifact: 'patch', evidence: 'source-read' })
    expect(task.authority.edit).toBe(true)
    const workflow = new AgentWorkflow({ intent: 'edit', agentId: 'composer', agentName: 'Composer', mode: 'agent',
      models: {chat:'simulated:test',tools:'simulated:test'}, toolPolicy:'edit', requiresTools:true,
      escalateToFull:false, reason:'test', method:'heuristic', task })
    workflow.noteTool({name:'read_file',ok:true,mutated:false,path:target})
    expect(workflow.evaluateOutcome({workspaceMutated:false,codeMutated:false,verifyPassed:false}).ok).toBe(false)
    workflow.noteTool({name:'write_file',ok:true,mutated:true,path:target})
    expect(workflow.evaluateOutcome({workspaceMutated:true,codeMutated:true,verifyPassed:true,filesTouched:[target]}).ok).toBe(true)
  })
  it.each(['Review the files and recommend improvements', 'Review the files, what should we improve?',
    'Review the files and improve the layout but do not edit files',
    'Review the files and suggest how to refactor them'])('does not grant writes for %s', async text => {
    const result = await captureQuestion(0, text, fixture({ 'index.html': '<main>Rentals</main>' }), 8192,
      'agent', new AbortController().signal)
    expect((result.task as TaskContract).authority.edit).toBe(false)
  })
})
