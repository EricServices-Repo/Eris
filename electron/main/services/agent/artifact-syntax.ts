import ts from 'typescript'
/** Parse only a single assembled JS/TS artifact explicitly requested as complete/runnable. No code is executed. */
export function assembledSyntax(
  answer: string,
  goal: string
): { state: 'valid' | 'invalid' | 'unavailable'; reason: string } {
  if (!/\b(?:complete|standalone|runnable)\b/i.test(goal))
    return { state: 'unavailable', reason: 'Reply may contain intentional fragments' }
  const blocks = [
    ...answer.matchAll(/^```(javascript|js|typescript|ts|tsx|jsx)\s*\n([\s\S]*?)^```\s*$/gm)
  ]
  if (blocks.length !== 1 || blocks[0][2].length > 100000)
    return { state: 'unavailable', reason: 'No single bounded assembled artifact' }
  const [language, code] = [blocks[0][1], blocks[0][2]]
  const source = ts.createSourceFile(
    'reply.' + language,
    code,
    ts.ScriptTarget.Latest,
    true,
    language === 'tsx'
      ? ts.ScriptKind.TSX
      : language === 'jsx'
        ? ts.ScriptKind.JSX
        : ['js', 'javascript'].includes(language)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
  )
  const diagnostics = (source as typeof source & { parseDiagnostics: ts.Diagnostic[] })
    .parseDiagnostics
  return {
    state: diagnostics.length ? 'invalid' : 'valid',
    reason: diagnostics.length
      ? 'Assembled artifact has parser errors'
      : 'Syntax only; not semantic correctness'
  }
}
