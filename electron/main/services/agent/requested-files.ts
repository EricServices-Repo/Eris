import { realpathSync, statSync } from 'fs'
import { relative, resolve } from 'path'
import type { TaskContract } from '../../../../src/shared/task-contract'
import { isPathInside } from '../workspace-fs'

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
  const missing = targets.filter(path => {
    try {
      const file = realpathSync(targetPath(path))
      const stat = statSync(file)
      return !isPathInside(projectRoot, file) || !stat.isFile() || stat.size === 0 || !observedPaths.has(file)
    } catch { return true }
  })
  return missing.length ? `Required files are missing, empty, outside the project, or not inspected: ${missing.join(', ')}.` : null
}
