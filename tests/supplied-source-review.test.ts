import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import { classifyIntent } from '../electron/main/services/chat-router'
import type { TaskContract } from '../src/shared/task-contract'
import { parsePersistedTask } from '../electron/main/services/evidence-schemas'

const roots: string[]=[]
function fixture(files: Record<string,string>) {
  const root=mkdtempSync(join(tmpdir(),'eris-intake-regression-'))
  roots.push(root)
  for(const [name,content] of Object.entries(files)) writeFileSync(join(root,name),content)
  return root
}
afterAll(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})))

describe('issue 437 supplied source reviews', () => {
  const source = '\n```js\nfunction sum(a, b) { return a - b }\n```'
  it.each(['Review this code sample:', 'Please review the following snippet:',
    'Could you review this code:', 'Explain this code:'])('uses supplied evidence for %s', async prefix => {
    const text = prefix + source
    const root = fixture({ 'index.html': '<main>UNRELATED PRIVATE PROJECT</main>' })
    for (const workspace of [root, null]) {
      const result = await captureQuestion(0, text, workspace, 8192, 'agent', new AbortController().signal)
      const task = result.task as TaskContract
      expect(task.scope.applicability).toBe('generic')
      expect(task.requested?.evidence).toBeUndefined()
      expect(task.authority).toMatchObject({ tools:'none',edit:false,execute:'none' })
      expect(parsePersistedTask(task).originalText).toContain('return a - b')
      const calls = result.requests.filter(request => request.purpose === 'agent')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.tools ?? []).toHaveLength(0)
      expect(JSON.stringify(calls[0]?.messages)).toContain('return a - b')
      expect(JSON.stringify(calls[0]?.messages)).not.toContain('UNRELATED PRIVATE PROJECT')
    }
  })
  it('keeps an explicit application to a workspace file as an edit', async () => {
    const text = 'Review this code sample and apply the fix to src/math.ts:' + source
    const root = fixture({})
    mkdirSync(join(root,'src'))
    writeFileSync(join(root,'src/math.ts'),'export const sum = (a:number,b:number) => a-b')
    const result = await captureQuestion(0, text, root,
      8192,'agent',new AbortController().signal)
    expect((result.task as TaskContract).scope.applicability).toBe('selected-project')
    expect((result.task as TaskContract).authority.edit).toBe(true)
  })
  it('does not treat quoted instructions or absent source as supplied evidence', async () => {
    expect(classifyIntent('"Review this code sample"' + source,'agent')).toBe('answer')
    const result = await captureQuestion(0,'Review this code',fixture({'index.html':'<main>News</main>'}),
      8192,'agent',new AbortController().signal)
    expect((result.task as TaskContract).requested?.evidence).toBe('source-read')
  })
})
