import { lstatSync, realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { unsafeSandboxPathReason } from '../../../src/shared/evals'

export class SandboxPathError extends Error {
  constructor(
    readonly path: string,
    reason: string
  ) {
    super(`Unsafe sandbox path “${path}”: ${reason}`)
    this.name = 'SandboxPathError'
  }
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `rel` under a disposable sandbox root, or throw. Rejects absolute,
 * drive-qualified, and traversal paths, then follows the nearest existing
 * ancestor through real paths so a symlink cannot redirect reads or writes.
 */
export function resolveSandboxPath(root: string, rel: string): string {
  const reason = unsafeSandboxPathReason(rel)
  if (reason) throw new SandboxPathError(rel, reason)
  const base = realpathSync(root)
  const target = resolve(base, rel)
  if (!isInside(base, target)) throw new SandboxPathError(rel, 'resolves outside the sandbox')
  let probe = target
  while (!exists(probe)) probe = dirname(probe)
  let real: string
  try {
    real = realpathSync(probe)
  } catch {
    throw new SandboxPathError(rel, 'dangling symlink')
  }
  if (!isInside(base, real)) throw new SandboxPathError(rel, 'symlink escapes the sandbox')
  return target
}
