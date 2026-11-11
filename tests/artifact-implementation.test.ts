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

describe('HTML and CSS structure checks (#509)', () => {
  const page = (body: string) =>
    `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Hi</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`

  it('reports the duplicated footer from the live test', () => {
    const r9 = page('<h1>Hello</h1>\n    <footer>\n    <p>© 2023 Eris</p>\n</footer>\n        <p>© 2023 Eris</p>\n    </footer>')
    expect(artifactProblem('hello.html', r9)).toMatch(/<\/footer>/)
  })

  it('accepts a valid page with void elements, comments and script strings', () => {
    const ok = page(
      '<!-- a <div> in a comment -->\n<header><img src="a.png" alt=""><br></header>\n<main>\n<ul><li>One<li>Two</ul>\n<p>Text<p>More\n<input type="text">\n</main>\n<footer><p>© Eris</p></footer>\n<script>const s = "</div>"; if (a < b) {}</script>\n<style>p > a { color: red }</style>'
    )
    expect(artifactProblem('index.html', ok)).toBeNull()
  })

  it('reports an unclosed block element and a second landmark', () => {
    expect(artifactProblem('a.html', page('<div class="x">\n<p>open'))).toMatch(/unclosed <div>/)
    expect(artifactProblem('a.html', page('<footer>a</footer>\n<footer>b</footer>'))).toMatch(/top-level <footer>/)
    expect(artifactProblem('a.html', page('<main></main><main></main>'))).toMatch(/more than one <main>/)
    expect(artifactProblem('a.htm', '<section><div></section>')).toMatch(/unclosed <div>/)
  })

  it('checks CSS braces outside strings and comments', () => {
    expect(artifactProblem('site.css', 'body { color: red;\nh1 { margin: 0 }')).toMatch(/unclosed \{/)
    expect(artifactProblem('site.css', 'a { content: "}" } /* } */\nb { x: 1 }')).toBeNull()
    expect(artifactProblem('site.css', 'a { x: 1 } }')).toMatch(/unbalanced \}/)
  })
})
