import { resolve } from 'path'
import { realpathAllowMissing, isPathInside } from './workspace-fs'
import type { ContextEvidence } from '../../../src/shared/context-evidence'
type State = {
  workspace: number
  floor: number
  paths: Map<string, { version: number; dirty: boolean }>
}
const roots = new Map<string, State>()
let sequence = 0
const state = (root: string) => {
  root = realpathAllowMissing(root)
  let entry = roots.get(root)
  if (!entry) {
    if (roots.size >= 64) roots.delete(roots.keys().next().value!)
    entry = { workspace: 0, floor: ++sequence, paths: new Map() }
    roots.set(root, entry)
  }
  return entry
}
export function noteEvidenceChange(root: string, path: string, dirty?: boolean) {
  root = realpathAllowMissing(root)
  const abs = realpathAllowMissing(resolve(root, path))
  if (!isPathInside(root, abs)) return
  const entry = state(root)
  entry.workspace = ++sequence
  if (entry.paths.size >= 1024 && !entry.paths.has(abs)) {
    entry.paths.clear()
    entry.floor = ++sequence
  }
  entry.paths.set(abs, {
    version: ++sequence,
    dirty: dirty ?? entry.paths.get(abs)?.dirty ?? false
  })
}
export function evidenceEpoch(
  root: string,
  paths: readonly string[]
): NonNullable<ContextEvidence['epoch']> {
  root = realpathAllowMissing(root)
  const entry = state(root),
    abs = paths.slice(0, 32).map((p) => realpathAllowMissing(resolve(root, p)))
  return {
    workspace: entry.workspace,
    floor: entry.floor,
    paths: abs.map((p) => [p, entry.paths.get(p)?.version ?? 0]),
    dirty: abs.some((p) => entry.paths.get(p)?.dirty)
  }
}
export function evidenceEpochMatches(snapshot: ContextEvidence) {
  if (!snapshot.epoch || snapshot.epoch.dirty) return false
  const current = evidenceEpoch(
    snapshot.root,
    snapshot.files.map((f) => f.path)
  )
  return !current.dirty && JSON.stringify(current) === JSON.stringify(snapshot.epoch)
}
