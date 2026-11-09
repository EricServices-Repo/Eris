import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { artifactProblem } from '../electron/main/services/agent/requested-files'
import { assessGoalCompletion } from '../electron/main/services/agent/heuristics'

describe('structural implementation evidence (#446)',()=>{
  it('accepts a small helper with independently exercised behavior',()=>{
    const code='module.exports = (a,b) => a+b;'
    expect(code.length).toBeLessThan(80)
    expect(artifactProblem('sum.js',code)).toBeNull()
    const module={exports:(_a:number,_b:number)=>0}
    runInNewContext(code,{module},{timeout:50})
    expect(module.exports(2,3)).toBe(5)
    expect(module.exports(-3,3)).toBe(0)
  })
  it.each(['.hidden{display:none}', '{"enabled":true}', 'export type Id = string',
    '// TODO: add documentation later\nexport const value = 1'])('keeps legitimate small artifacts: %s',code=>{
    const path=code.startsWith('.')?'main.css':code.startsWith('{')?'settings.json':'value.ts'
    expect(artifactProblem(path,code)).toBeNull()
  })
  it.each(['export function book() { throw new Error("TODO: implement booking") }',
    'export const book = () => { throw new NotImplementedError() }',
    '// TODO: implement booking\nexport function book() {}'])('rejects padded placeholders: %s',body=>{
    const code='// descriptive padding\n'.repeat(500)+body
    expect(code.length).toBeGreaterThan(250)
    const problem=artifactProblem('booking.ts',code)
    expect(problem).toBe('explicit placeholder implementation')
    expect(assessGoalCompletion({goal:'Implement booking',assistantText:'DONE',actionLog:['Wrote booking.ts'],
      filesTouched:['booking.ts'],codeMutated:true,reviewOnly:false,verifyPassed:true,
      artifactProblems:[problem!]}).unmet).toBe(true)
  })
  it('does not confuse an intentional runtime exception with a placeholder',()=>{
    expect(artifactProblem('validate.ts','export function validate() { throw new Error("Invalid input") }')).toBeNull()
  })
})
