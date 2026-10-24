import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

/** Reject every link component: a cloned repository must not redirect service I/O. */
export function confinedPath(workspace: string, input: string): string {
  if (
    typeof input !== 'string' ||
    !input ||
    input.includes('\0') ||
    isAbsolute(input) ||
    /^[A-Za-z]:/.test(input) ||
    input.startsWith('\\')
  )
    throw new Error('Invalid workspace path')
  const segments = input.replace(/\\/g, '/').split('/')
  if (segments.includes('..')) throw new Error('Path escapes workspace')
  const root = realpathSync(workspace)
  const target = resolve(root, ...segments)
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
    throw new Error('Path escapes workspace')
  let current = root
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('Workspace symbolic links are not allowed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return target
}

export function readBoundedText(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('Not a regular file')
    const bound = Math.max(1, Math.min(4_000_000, Math.floor(limit)))
    const buffer = Buffer.alloc(Math.min(st.size, bound))
    let offset = 0
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (!bytes) break
      offset += bytes
    }
    return buffer.subarray(0, offset).toString('utf8') + (st.size > bound ? '\n\n[truncated]' : '')
  } finally {
    closeSync(fd)
  }
}
