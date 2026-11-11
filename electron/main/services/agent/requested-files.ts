import { readFileSync, realpathSync, statSync } from 'fs'
import { extname, relative, resolve } from 'path'
import ts from 'typescript'
import type { TaskContract } from '../../../../src/shared/task-contract'
import { isPathInside } from '../workspace-fs'

const CODE_TARGET = /\.(?:[cm]?[jt]sx?|json|php|py|rs|go|java|cs|cpp|c|h)$/i

export function requiresRequestedCodeVerification(task: TaskContract): boolean {
  return requestedCodeTargets(task).length > 0
}

/** Requested output files that are source code and so would need a project check. */
export function requestedCodeTargets(task: TaskContract): string[] {
  return (task.requested?.targetFiles ?? []).filter(path => CODE_TARGET.test(path))
}

/** Files `artifactProblem` can actually parse. Other code files get no structural check. */
export function syntaxCheckable(path: string): boolean {
  return /\.(?:json|[cm]?[jt]sx?)$/i.test(path)
}

/** Bounded parsing only: never evaluate generated code or invoke a host command. */
export function artifactProblem(path: string, text: string): string | null {
  const extension = extname(path).toLowerCase()
  if (extension === '.json') {
    try { JSON.parse(text) } catch { return 'invalid JSON' }
  }
  if (/^\.[cm]?[jt]sx?$/.test(extension)) {
    const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
    if ((source as typeof source & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length)
      return 'syntax errors'
    if (!source.statements.some(statement => !ts.isEmptyStatement(statement))) return 'no implementation statements'
    const implementations: ts.ConciseBody[] = []
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.body)
        implementations.push(node.body)
      ts.forEachChild(node,visit)
    }
    visit(source)
    const marker = /\bTODO\b|not[ -]?implemented|implement\s+me|placeholder/i
    const stub = (body: ts.ConciseBody) => ts.isBlock(body) && (
      (body.statements.length === 0 && marker.test(text)) ||
      (body.statements.length === 1 && ts.isThrowStatement(body.statements[0]!) &&
        marker.test(body.statements[0]!.getText(source))))
    if (implementations.length && implementations.every(stub)) return 'explicit placeholder implementation'
  }
  if (extension === '.php' && !text.replace(/<\?(?:php)?|\?>|^\s*(?:\/\/|#)[^\n]*|\/\*[\s\S]*?\*\//gm, '').trim())
    return 'empty PHP implementation'
  return null
}

/** Required outputs are project identities, never suffix/basename matches. */
export function requestedFilesProblem(task: TaskContract, observed: readonly string[]): string | null {
  const targets = task.requested?.targetFiles ?? []
  if (!targets.length) return null
  const { workspaceRoot, projectRoot } = task.scope
  if (!workspaceRoot || !projectRoot) return 'The requested files have no resolved project.'
  const projectPrefix = relative(workspaceRoot, projectRoot).replace(/\\/g, '/')
  const targetPath = (path: string) => {
    const normalized = path.replace(/\\/g, '/')
    const base = projectPrefix && normalized.startsWith(projectPrefix + '/') ? workspaceRoot : projectRoot
    return resolve(base, normalized)
  }
  const observedPaths = new Set(observed.map(path => {
    try { return realpathSync(resolve(workspaceRoot, path.replace(/\\/g, '/'))) }
    catch { return '' }
  }))
  let bytes = 0
  const problems: string[] = []
  const missing = targets.filter(path => {
    try {
      const file = realpathSync(targetPath(path))
      const stat = statSync(file)
      if (!isPathInside(projectRoot, file) || !stat.isFile() || stat.size === 0 || !observedPaths.has(file)) return true
      bytes += stat.size
      if (stat.size > 1_000_000 || bytes > 2_000_000) {
        problems.push(`${path}: artifact validation size limit exceeded`)
        return false
      }
      const problem = artifactProblem(file, readFileSync(file, 'utf8'))
      if (problem) problems.push(`${path}: ${problem}`)
      return false
    } catch { return true }
  })
  if (missing.length) return `Required files are missing, empty, outside the project, or not inspected: ${missing.join(', ')}.`
  return problems.length ? `Required artifacts failed validation: ${problems.join('; ')}.` : null
}
