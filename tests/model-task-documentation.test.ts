import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MODEL_FACING_TASK_SCHEMA, modelFacingTask } from '../electron/main/services/agent/context-compiler'
import { createTaskContract } from '../electron/main/services/task-intake'
import { parsePersistedTask } from '../electron/main/services/evidence-schemas'
import type { TurnPlan } from '../src/shared/settings-schema'

const root=mkdtempSync(join(tmpdir(),'eris-task-doc-'))
afterAll(()=>rmSync(root,{recursive:true,force:true}))
const plan:TurnPlan={intent:'review',agentId:'reviewer',agentName:'Reviewer',mode:'agent',
  models:{chat:'simulated:docs',tools:'simulated:docs'},toolPolicy:'read',requiresTools:true,
  escalateToFull:false,reason:'documentation fixture',method:'heuristic'}
const task=createTaskContract({workspacePath:root,text:'Review the files',taskId:'source-review-example',plan})
const projection=modelFacingTask(task)
describe('canonical model-task documentation (#471)',()=>{
  it('matches the JSON example to the model-facing projection of a real task fixture',()=>{
    const doc=readFileSync(join(__dirname,'../docs/design/REQUEST-EXECUTION.md'),'utf8')
    const example=/<!-- model-task-example:start -->\s*```json\s*([\s\S]*?)```\s*<!-- model-task-example:end -->/.exec(doc)
    expect(example,'source-checked example block').not.toBeNull()
    expect(JSON.parse(example![1]!)).toEqual({schema:MODEL_FACING_TASK_SCHEMA,requested:projection.requested})
    expect(doc).toContain("evidence?: 'source-read'")
  })
  it.each(['docs/ARCHITECTURE.md','docs/design/REQUEST-EXECUTION.md'])(
    '%s names the current wire schema without stale current-version examples',path=>{
      const doc=readFileSync(join(__dirname,'..',path),'utf8')
      const versions=doc.match(/model-task\/\d+/g)??[]
      expect(versions.length).toBeGreaterThan(0)
      expect(versions.every(version=>version===MODEL_FACING_TASK_SCHEMA)).toBe(true)
    })
  it('keeps saved version-2 compatibility separate from current wire evidence',()=>{
    expect(task.version).toBe(2)
    const {requested: _requested,...legacy}=task
    expect(parsePersistedTask(legacy).requested).toBeUndefined()
    expect((projection.requested as {evidence:string}).evidence).toBe('source-read')
  })
})
