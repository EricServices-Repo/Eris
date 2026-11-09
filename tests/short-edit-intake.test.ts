import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import { classifyIntent } from '../electron/main/services/chat-router'
import { recordRoutingCorrection } from '../electron/main/services/routing-feedback'
import type { TaskContract } from '../src/shared/task-contract'

const roots: string[]=[]
function fixture(files: Record<string,string>) {
  const root=mkdtempSync(join(tmpdir(),'eris-intake-regression-'))
  roots.push(root)
  for(const [name,content] of Object.entries(files)) writeFileSync(join(root,name),content)
  return root
}
afterAll(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})))

describe('issue 434 short edit requests', () => {
  it('does not let a learned answer correction erase an explicit operation', async () => {
    const text='Add pagination'
    recordRoutingCorrection({text,from:'edit',to:'answer',agentId:'explainer'})
    const result=await captureQuestion(0,text,fixture({'index.html':'<main>Rentals</main>'}),8192,
      'agent',new AbortController().signal)
    expect((result.task as TaskContract).authority.edit).toBe(true)
    expect(result.intent).toBe('edit')
  })
  it.each(['Add pagination', 'Add search', 'Add login and logout', 'Add tests for this',
    'Remove the debug banner', 'Change the button to blue', 'Save this as README.md'])(
    'preserves requested implementation for %s with and without a project', async text => {
    expect(classifyIntent(text, 'agent')).toBe('edit')
    for (const root of [fixture({ 'index.html': '<main>Rentals</main>' }), null]) {
      const result = await captureQuestion(0, text, root, 8192, 'agent', new AbortController().signal)
      const task = result.task as TaskContract
      expect(task.requested?.artifact).toBe('patch')
      if (root) {
        expect(task.authority.edit).toBe(true)
        expect(task.scope.applicability).toBe('selected-project')
        expect(JSON.stringify(result.requests.find(r => r.purpose === 'agent')?.tools)).toContain('write_file')
      } else {
        expect(result.requests.filter(r => r.purpose === 'agent')).toHaveLength(0)
      }
    }
  })
  it.each(['What is the best way to add pagination?', 'Write a story about a robot',
    '"Add pagination"', 'Add 2 and 3', 'Change the subject'])('keeps conversational requests read-only: %s', text => {
    expect(classifyIntent(text, 'agent')).not.toBe('edit')
  })
  it('preserves explicit no-edit and Ask ceilings', async () => {
    const root = fixture({ 'index.html': '<main>Rentals</main>' })
    for (const [text, mode] of [['Add search but do not edit files', 'agent'], ['Add search', 'ask']] as const) {
      const result = await captureQuestion(0, text, root, 8192, mode, new AbortController().signal)
      expect((result.task as TaskContract).authority.edit).toBe(false)
    }
  })
})
