import { isAbsolute, relative, sep } from 'path'
import { realpathAllowMissing } from '../workspace-fs'

type Waiter = {
  project: string
  grant: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  cancel: () => void
}
const active = new Set<Waiter>()
const waiting: Waiter[] = []
const aborted = () =>
  Object.assign(new Error('Aborted while waiting for project execution'), { name: 'AbortError' })

function contains(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
}
function overlaps(a: Waiter, b: Waiter): boolean {
  return contains(a.project, b.project) || contains(b.project, a.project)
}
function pump(): void {
  for (let index = 0; index < waiting.length;) {
    const next = waiting[index]!
    if (next.signal?.aborted) {
      waiting.splice(index, 1)
      next.signal.removeEventListener('abort', next.cancel)
      next.reject(aborted())
      continue
    }
    // An older overlapping waiter keeps its place; unrelated projects may proceed.
    if ([...active, ...waiting.slice(0, index)].some((other) => overlaps(next, other))) {
      index++
      continue
    }
    waiting.splice(index, 1)
    next.signal?.removeEventListener('abort', next.cancel)
    active.add(next)
    let released = false
    next.grant(() => {
      if (released) return
      released = true
      active.delete(next)
      pump()
    })
  }
}

/** Serialize overlapping canonical project roots, including workspace/subproject writes. */
export function acquireProjectWrite(project: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(aborted())
  const canonical = realpathAllowMissing(project)
  return new Promise((grant, reject) => {
    const waiter: Waiter = {
      project: canonical,
      grant,
      reject,
      signal,
      cancel: () => {
        const index = waiting.indexOf(waiter)
        if (index < 0) return
        waiting.splice(index, 1)
        signal?.removeEventListener('abort', waiter.cancel)
        reject(aborted())
        pump()
      }
    }
    waiting.push(waiter)
    signal?.addEventListener('abort', waiter.cancel, { once: true })
    pump()
  })
}
