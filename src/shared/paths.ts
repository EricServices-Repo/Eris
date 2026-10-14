/** Cross-platform path helpers for the renderer (no Node `path` dependency). */

export function isAbsPath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)
}

export function pathBasename(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : p
}

/** Join a workspace root with a relative (or already-absolute) path. */
export function joinWorkspacePath(root: string, rel: string): string {
  const part = (rel.split(' → ')[0] || rel).trim()
  if (!root) return part
  if (isAbsPath(part)) return part
  const useWin = /\\/.test(root) && !root.startsWith('/')
  const sep = useWin ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  const tail = part.replace(/\\/g, '/').replace(/^\.?\//, '')
  return useWin ? `${base}\\${tail.replace(/\//g, '\\')}` : `${base}/${tail}`
}
