// Pure Node boundary checks, also used by worker threads without Electron.
import { existsSync, realpathSync } from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Realpath of the path, or of its nearest existing ancestor joined with the missing tail. */
export function realpathAllowMissing(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.unshift(basename(cur))
    cur = parent
  }
  return join(realpathOrSelf(cur), ...tail)
}

/** True when target is root or inside it after resolving symlinks. */
export function isPathInside(root: string, target: string): boolean {
  const realRoot = realpathOrSelf(root)
  const realTarget = realpathAllowMissing(target)
  const rel = relative(realRoot, realTarget)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))
}
