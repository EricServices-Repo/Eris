import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureQuestion } from '../electron/dev/capture'
import type { TaskContract } from '../src/shared/task-contract'

const roots:string[]=[]
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'eris-hypothetical-'))
  roots.push(root)
  writeFileSync(join(root,'index.html'),'<main>PRIVATE CALCULATOR PROJECT</main>')
  return root
}
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})))
describe('hypothetical review scope (#441)',()=>{
  it.each(['What features should we add to a news site?',
    'Review the architecture of a typical news application',
    'Review an existing Next.js project in general',
    'What improvements should a rental website have?',
    'Review the following specification for a news site:\n```text\nReaders can bookmark articles.\n```'])(
    'answers %s without borrowing the open workspace',async text=>{
    const result=await captureQuestion(0,text,fixture(),8192,'agent',new AbortController().signal)
    const task=result.task as TaskContract
    expect(task.scope.applicability).toBe('generic')
    expect(task.authority).toMatchObject({tools:'none',edit:false,execute:'none'})
    const call=result.requests.find(request=>request.purpose==='agent')
    expect(call?.tools??[]).toHaveLength(0)
    expect(JSON.stringify(call?.messages)).not.toContain('PRIVATE CALCULATOR PROJECT')
    if(text.includes('Readers can bookmark')) expect(JSON.stringify(call?.messages)).toContain('Readers can bookmark')
  })
  it.each(['Review this website and recommend features','Review our dashboard in general',
    'Review the files for a news site'])('keeps explicit project inspection: %s',async text=>{
    const result=await captureQuestion(0,text,fixture(),8192,'agent',new AbortController().signal)
    expect((result.task as TaskContract).scope.applicability).toBe('selected-project')
    expect(JSON.stringify(result.requests.find(request=>request.purpose==='agent')?.tools)).toContain('read_file')
  })
  it('keeps an explicitly named sibling project instead of a generic description',async()=>{
    const root=fixture();mkdirSync(join(root,'airbnb'))
    writeFileSync(join(root,'airbnb/package.json'),JSON.stringify({name:'airbnb'}))
    const result=await captureQuestion(0,'Review the Airbnb website project',root,8192,'agent',new AbortController().signal)
    expect((result.task as TaskContract).scope.applicability).toBe('named-target')
    expect((result.task as TaskContract).scope.projectRoot).toMatch(/airbnb$/)
  })
})
