import { atomicEvidenceJson, readEvidence } from './evidence-records'
import { CheckpointSchema } from './evidence-schemas'
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { randomUUID, createHash } from 'crypto'
import { workspaceConfigDir } from './paths'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace-fs'

type CheckpointOperation =
  | { kind: 'binary-create'; path: string }
  | { kind: 'write'; path: string; before: string | null; after: string; beforeBase64?: string }
  | { kind: 'delete'; path: string; before: string; wasDirectory: boolean; beforeBase64?: string }
  | { kind: 'rename'; from: string; to: string; before: string | null }
  | { kind: 'mkdir'; path: string }

interface CheckpointPostimage {
  kind: 'file' | 'directory'
  digest?: string
  dev: number
  ino: number
}
export type CheckpointFileOp = CheckpointOperation & {
  operationId?: string
  postimage?: CheckpointPostimage
  reversedAt?: number
}

function digest(path: string): string {
  const fd = openSync(path, 'r'),
    hash = createHash('sha256'),
    buffer = Buffer.alloc(64 * 1024)
  try {
    let size: number
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, size))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
function postimage(path: string): CheckpointPostimage | undefined {
  if (!existsSync(path)) return undefined
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('Checkpoint target is a symbolic link')
  return {
    kind: stat.isDirectory() ? 'directory' : 'file',
    dev: stat.dev,
    ino: stat.ino,
    ...(stat.isFile() ? { digest: digest(path) } : {})
  }
}
const textDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * File content before a change. `text` is what diffs show. When the file is not valid
 * UTF-8, `text` is a lossy display copy and `base64` holds the exact bytes undo
 * restores; writing `text` back would replace every undecodable byte.
 */
export type Preimage = { text: string; base64?: string }

export function readPreimage(abs: string): Preimage {
  const raw = readFileSync(abs)
  try {
    return { text: strictUtf8.decode(raw) }
  } catch {
    return { text: raw.toString('utf8'), base64: raw.toString('base64') }
  }
}

type RecordedPreimage = { before: string; beforeBase64?: string }
const preimageBytes = (op: RecordedPreimage) =>
  op.beforeBase64 === undefined
    ? Buffer.from(op.before, 'utf8')
    : Buffer.from(op.beforeBase64, 'base64')
const preimageDigest = (op: RecordedPreimage) =>
  createHash('sha256').update(preimageBytes(op)).digest('hex')

export interface CheckpointRecord {
  schemaVersion?: 1
  owner?: { taskId: string; threadId: string | null }
  id: string
  createdAt: number
  workspacePath: string
  ops: CheckpointFileOp[]
}

export class CheckpointConflictError extends Error {
  readonly code = 'CHECKPOINT_CONFLICT'
  constructor(
    readonly path: string,
    readonly reason:
      | 'directory-not-empty'
      | 'directory-replaced'
      | 'file-changed'
      | 'target-exists'
      | 'missing-postimage',
    readonly versions?: { before: string | null; agent: string | null; currentDigest?: string }
  ) {
    super(
      `Cannot undo ${path}: ${reason}. Newer content was preserved; review the current file and checkpoint diff before retrying.`
    )
    this.name = 'CheckpointConflictError'
  }
}

function checkpointsRoot(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'checkpoints')
}

function checkpointMetaPath(workspacePath: string, id: string): string {
  return join(checkpointsRoot(workspacePath), id, 'meta.json')
}

export function createCheckpoint(
  workspacePath: string,
  owner?: { taskId: string; threadId: string | null }
): CheckpointRecord {
  const id = randomUUID()
  const dir = join(checkpointsRoot(workspacePath), id)
  mkdirSync(dir, { recursive: true })
  const record: CheckpointRecord = {
    id,
    schemaVersion: 1,
    ...(owner ? { owner } : {}),
    createdAt: Date.now(),
    workspacePath,
    ops: []
  }
  atomicEvidenceJson(checkpointMetaPath(workspacePath, id), record)
  return record
}

function saveRecord(record: CheckpointRecord): void {
  atomicEvidenceJson(checkpointMetaPath(record.workspacePath, record.id), record)
}

export function loadCheckpoint(workspacePath: string, id: string): CheckpointRecord | null {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null
  return readEvidence(
    checkpointMetaPath(workspacePath, id),
    (value) => {
      const record = CheckpointSchema.parse(value) as CheckpointRecord
      if (record.id !== id || realpathSync(record.workspacePath) !== realpathSync(workspacePath))
        throw new Error('Checkpoint identity or workspace does not match its owner')
      return record
    },
    64_000_000
  )
}

/** Exact current file content before an agent write (null if new file). */
export function snapshotPreimage(workspacePath: string, userPath: string): Preimage | null {
  const abs = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null
  try {
    return readPreimage(abs)
  } catch {
    return null
  }
}

/** Display text of the file before an agent write (null if new file). */
export function snapshotBeforeWrite(
  workspacePath: string,
  _checkpointId: string,
  userPath: string
): string | null {
  return snapshotPreimage(workspacePath, userPath)?.text ?? null
}

export function recordWriteOp(
  workspacePath: string,
  checkpointId: string,
  userPath: string,
  before: string | null,
  after: string,
  /** Exact preimage bytes when `before` is only a lossy display copy. */
  beforeBase64?: string
): CheckpointRecord | null {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) return null
  const rel = toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, userPath))
  record.ops.push({
    kind: 'write',
    path: rel,
    before,
    after,
    ...(before !== null && beforeBase64 !== undefined ? { beforeBase64 } : {}),
    operationId: randomUUID(),
    postimage: postimage(resolveInWorkspace(workspacePath, userPath))
  })
  saveRecord(record)
  return record
}

export function recordDeleteOp(
  workspacePath: string,
  checkpointId: string,
  userPath: string,
  before: string,
  wasDirectory: boolean,
  /** Exact preimage bytes when `before` is only a lossy display copy. */
  beforeBase64?: string
): CheckpointRecord | null {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) return null
  const rel = toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, userPath))
  record.ops.push({
    kind: 'delete',
    path: rel,
    before,
    wasDirectory,
    ...(!wasDirectory && beforeBase64 !== undefined ? { beforeBase64 } : {}),
    operationId: randomUUID()
  })
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
    before,
    operationId: randomUUID(),
    postimage: postimage(resolveInWorkspace(workspacePath, toPath))
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
  record.ops.push({
    kind: 'mkdir',
    path: rel,
    operationId: randomUUID(),
    postimage: postimage(resolveInWorkspace(workspacePath, userPath))
  })
  saveRecord(record)
  return record
}

/** Generated images are new files; undo removes the binary without interpreting it as text. */
export function recordBinaryCreateOp(
  workspacePath: string,
  checkpointId: string,
  path: string
): CheckpointRecord {
  const record = loadCheckpoint(workspacePath, checkpointId)
  if (!record) throw new Error('Checkpoint not found')
  record.ops.push({
    kind: 'binary-create',
    path: toWorkspaceRelative(workspacePath, resolveInWorkspace(workspacePath, path)),
    operationId: randomUUID(),
    postimage: postimage(resolveInWorkspace(workspacePath, path))
  })
  saveRecord(record)
  return record
}

function applyReverseOp(workspacePath: string, op: CheckpointFileOp): boolean {
  if (op.reversedAt) return false
  const target = op.kind === 'rename' ? op.to : op.path
  const abs = resolveInWorkspace(workspacePath, target)
  const current = postimage(abs)
  const conflict = (reason: CheckpointConflictError['reason']): never => {
    throw new CheckpointConflictError(target, reason, {
      before: 'before' in op ? op.before : null,
      agent: op.kind === 'write' ? op.after : null,
      currentDigest: current?.digest
    })
  }
  const matches = (expected: CheckpointPostimage | undefined, expectedDigest?: string): boolean => {
    if (!current) return false
    if (
      expected &&
      (current.kind !== expected.kind ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino)
    )
      return false
    return expectedDigest
      ? current.digest === expectedDigest
      : Boolean(expected && current.digest === expected.digest)
  }
  if (op.kind === 'binary-create') {
    if (!current) return false
    if (!op.postimage?.digest) return conflict('missing-postimage')
    if (!matches(op.postimage, op.postimage.digest)) return conflict('file-changed')
    unlinkSync(abs)
  } else if (op.kind === 'write') {
    // An interrupted prior undo may already have restored the preimage.
    if (op.before === null && !current) return false
    if (
      op.before !== null &&
      current?.digest === preimageDigest({ before: op.before, beforeBase64: op.beforeBase64 }) &&
      (op.beforeBase64 !== undefined || op.before !== op.after)
    )
      return false
    // Text rollback compares content: later agent writes may have atomically replaced
    // the inode before a newer operation restored this exact postimage.
    if (!matches(undefined, textDigest(op.after))) return conflict('file-changed')
    if (op.before === null) unlinkSync(abs)
    else writeFileSync(abs, preimageBytes({ before: op.before, beforeBase64: op.beforeBase64 }))
  } else if (op.kind === 'delete') {
    if (current) {
      if (!op.wasDirectory && current.digest === preimageDigest(op)) return false
      return conflict('target-exists')
    }
    mkdirSync(dirname(abs), { recursive: true })
    if (op.wasDirectory) mkdirSync(abs)
    else writeFileSync(abs, preimageBytes(op), { flag: 'wx' })
  } else if (op.kind === 'rename') {
    const original = resolveInWorkspace(workspacePath, op.from)
    const originalState = postimage(original)
    if (
      !current &&
      originalState &&
      op.before !== null &&
      originalState.digest === textDigest(op.before)
    )
      return false
    if (originalState) return conflict('target-exists')
    if (!op.postimage && op.before === null) return conflict('missing-postimage')
    if (
      !matches(
        op.postimage,
        op.postimage?.digest ?? (op.before === null ? undefined : textDigest(op.before))
      )
    )
      return conflict('file-changed')
    mkdirSync(dirname(original), { recursive: true })
    renameSync(abs, original)
  } else if (op.kind === 'mkdir') {
    if (!current) return false
    if (current.kind !== 'directory' || (op.postimage && !matches(op.postimage)))
      return conflict('directory-replaced')
    try {
      rmdirSync(abs)
    } catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return conflict('directory-not-empty')
      throw error
    }
  }
  return true
}

function reverseRecordedOp(record: CheckpointRecord, index: number): boolean {
  const op = record.ops[index]
  if (op.reversedAt) return false
  const changed = applyReverseOp(record.workspacePath, op)
  op.reversedAt = Date.now()
  op.operationId ??= `${record.id}:${index}`
  saveRecord(record)
  return changed
}

/** Restore workspace to state before the checkpoint ops (reverse order). */
export function restoreCheckpoint(workspacePath: string, id: string): { restored: number } {
  const record = loadCheckpoint(workspacePath, id)
  if (!record) throw new Error('Checkpoint not found')
  let restored = 0
  for (let i = record.ops.length - 1; i >= 0; i--) {
    if (reverseRecordedOp(record, i)) restored++
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
  const changed = reverseRecordedOp(record, opIndex)
  const path = op.kind === 'rename' ? op.from : 'path' in op ? op.path : undefined
  return { restored: changed ? 1 : 0, path }
}

export function getCheckpointOpCount(workspacePath: string, id: string): number {
  const record = loadCheckpoint(workspacePath, id)
  return record?.ops.length ?? 0
}

/**
 * Rewind the workspace to the state after `keepOps` recorded ops, then truncate
 * the checkpoint log so later resume continues cleanly from that boundary.
 */
export function restoreCheckpointThrough(
  workspacePath: string,
  id: string,
  keepOps: number
): { restored: number; kept: number } {
  const record = loadCheckpoint(workspacePath, id)
  if (!record) throw new Error('Checkpoint not found')
  const keep = Math.max(0, Math.min(keepOps, record.ops.length))
  let restored = 0
  for (let i = record.ops.length - 1; i >= keep; i--) {
    if (reverseRecordedOp(record, i)) restored++
  }
  record.ops = record.ops.slice(0, keep)
  saveRecord(record)
  return { restored, kept: keep }
}

export function listCheckpoints(
  workspacePath: string
): Array<{ id: string; createdAt: number; opCount: number }> {
  const root = checkpointsRoot(workspacePath)
  if (!existsSync(root)) return []
  const out: Array<{ id: string; createdAt: number; opCount: number }> = []
  for (const name of readdirSync(root)) {
    const record = loadCheckpoint(workspacePath, name)
    if (record) out.push({ id: record.id, createdAt: record.createdAt, opCount: record.ops.length })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** Legacy call retained for callers; terminal-aware Settings maintenance owns retention. */
export function pruneOldCheckpoints(_workspacePath: string, _keep = 20): void {}
