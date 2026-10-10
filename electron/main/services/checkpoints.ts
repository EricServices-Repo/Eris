import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { workspaceConfigDir } from './paths'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace-fs'

export type CheckpointFileOp =
  | { kind: 'write'; path: string; before: string | null; after: string }
  | { kind: 'delete'; path: string; before: string; wasDirectory: boolean }
  | { kind: 'rename'; from: string; to: string; before: string | null }
  | { kind: 'mkdir'; path: string }

export interface CheckpointRecord {
  id: string
  createdAt: number
  workspacePath: string
  ops: CheckpointFileOp[]
}

function checkpointsRoot(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'checkpoints')
}

function checkpointMetaPath(workspacePath: string, id: string): string {
  return join(checkpointsRoot(workspacePath), id, 'meta.json')
}

export function createCheckpoint(workspacePath: string): CheckpointRecord {
  const id = randomUUID()
  const dir = join(checkpointsRoot(workspacePath), id)
  mkdirSync(dir, { recursive: true })
  const record: CheckpointRecord = {
    id,
    createdAt: Date.now(),
    workspacePath,
    ops: []
  }
  writeFileSync(checkpointMetaPath(workspacePath, id), JSON.stringify(record, null, 2), 'utf8')
  return record
}

function saveRecord(record: CheckpointRecord): void {
  writeFileSync(
    checkpointMetaPath(record.workspacePath, record.id),
    JSON.stringify(record, null, 2),
    'utf8'
  )
}

export function loadCheckpoint(
  workspacePath: string,
  id: string
): CheckpointRecord | null {
  const path = checkpointMetaPath(workspacePath, id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CheckpointRecord
  } catch {
    return null
  }
}

/** Snapshot current file content before an agent write (null if new file). */
export function snapshotBeforeWrite(
  workspacePath: string,
  checkpointId: string,
  userPath: string
): string | null {
  const abs = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

export function recordWriteOp(
  workspacePath: string,
  checkpointId: string,
  userPath: string,
  before: string | null,
  after: string
): CheckpointRecord | null {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) return null
  const rel = toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, userPath))
  record.ops.push({ kind: 'write', path: rel, before, after })
  saveRecord(record)
  return record
}

export function recordDeleteOp(
  workspacePath: string,
  checkpointId: string,
  userPath: string,
  before: string,
  wasDirectory: boolean
): CheckpointRecord | null {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) return null
  const rel = toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, userPath))
  record.ops.push({ kind: 'delete', path: rel, before, wasDirectory })
  saveRecord(record)
  return record
}

export function recordRenameOp(
  workspacePath: string,
  checkpointId: string,
  fromPath: string,
  toPath: string,
  before: string | null
): CheckpointRecord | null {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) return null
  record.ops.push({
    kind: 'rename',
    from: toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, fromPath)),
    to: toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, toPath)),
    before
  })
  saveRecord(record)
  return record
}

export function recordMkdirOp(
  workspacePath: string,
  checkpointId: string,
  userPath: string
): CheckpointRecord | null {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) return null
  const rel = toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, userPath))
  record.ops.push({ kind: 'mkdir', path: rel })
  saveRecord(record)
  return record
}

function applyReverseOp(workspacePath: string, op: CheckpointFileOp): boolean {
  try {
    if (op.kind === 'write') {
      const abs = resolveInWorkspace(workspacePath, op.path)
      if (op.before == null) {
        if (existsSync(abs)) unlinkSync(abs)
      } else {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, op.before, 'utf8')
      }
      return true
    }
    if (op.kind === 'delete') {
      const abs = resolveInWorkspace(workspacePath, op.path)
      mkdirSync(dirname(abs), { recursive: true })
      if (op.wasDirectory) mkdirSync(abs, { recursive: true })
      else writeFileSync(abs, op.before, 'utf8')
      return true
    }
    if (op.kind === 'rename') {
      const fromAbs = resolveInWorkspace(workspacePath, op.to)
      const toAbs = resolveInWorkspace(workspacePath, op.from)
      if (existsSync(fromAbs)) {
        mkdirSync(dirname(toAbs), { recursive: true })
        renameSync(fromAbs, toAbs)
      } else if (op.before != null) {
        mkdirSync(dirname(toAbs), { recursive: true })
        writeFileSync(toAbs, op.before, 'utf8')
      }
      return true
    }
    if (op.kind === 'mkdir') {
      const abs = resolveInWorkspace(workspacePath, op.path)
      if (existsSync(abs)) {
        try {
          rmSync(abs, { recursive: true, force: true })
        } catch {
          // ignore non-empty
        }
      }
      return true
    }
  } catch {
    return false
  }
  return false
}

/** Restore workspace to state before the checkpoint ops (reverse order). */
export function restoreCheckpoint(workspacePath: string, id: string): { restored: number } {
  const record = loadCheckpoint(workspacePath, id)
  if (!record) throw new Error('Checkpoint not found')
  let restored = 0
  for (let i = record.ops.length - 1; i >= 0; i--) {
    if (applyReverseOp(workspacePath, record.ops[i]!)) restored++
  }
  return { restored }
}

/** Undo a single recorded op (per-file undo). */
export function restoreCheckpointOp(
  workspacePath: string,
  id: string,
  opIndex: number
): { restored: number; path?: string } {
  const record = loadCheckpoint(workspacePath, id)
  if (!record) throw new Error('Checkpoint not found')
  const op = record.ops[opIndex]
  if (!op) throw new Error(`Checkpoint op ${opIndex} not found`)
  const ok = applyReverseOp(workspacePath, op)
  if (!ok) throw new Error('Failed to restore file from checkpoint')
  const path =
    op.kind === 'rename' ? op.from : 'path' in op ? op.path : undefined
  return { restored: 1, path }
}

export function listCheckpoints(workspacePath: string): Array<{ id: string; createdAt: number; opCount: number }> {
  const root = checkpointsRoot(workspacePath)
  if (!existsSync(root)) return []
  const out: Array<{ id: string; createdAt: number; opCount: number }> = []
  for (const name of readdirSync(root)) {
    const record = loadCheckpoint(workspacePath, name)
    if (record) out.push({ id: record.id, createdAt: record.createdAt, opCount: record.ops.length })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function pruneOldCheckpoints(workspacePath: string, keep = 20): void {
  const list = listCheckpoints(workspacePath)
  for (const item of list.slice(keep)) {
    try {
      rmSync(join(checkpointsRoot(workspacePath), item.id), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
