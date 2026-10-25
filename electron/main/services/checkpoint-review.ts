import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { workspaceConfigDir } from './paths'
import { loadCheckpoint, restoreCheckpointOp, type CheckpointFileOp } from './checkpoints'
import { realpathAllowMissing } from './workspace-fs'
import type {
  CheckpointReviewItem,
  CheckpointReviewRequest
} from '../../../src/shared/checkpoint-review'

type Decision = {
  fingerprint: string
  status: 'kept' | 'undone' | 'conflicted' | 'undoing'
  reason?: string
}
interface Review {
  version: 1
  workspace: string
  checkpointId: string
  decisions: Record<string, Decision>
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function context(root: string, checkpointId: string) {
  if (!uuid.test(checkpointId)) throw new Error('Invalid checkpoint ID')
  const record = loadCheckpoint(root, checkpointId)
  const workspace = realpathAllowMissing(root)
  if (
    !record ||
    record.id !== checkpointId ||
    realpathAllowMissing(record.workspacePath) !== workspace
  )
    throw new Error('Checkpoint does not belong to this workspace')
  const path = join(workspaceConfigDir(root), 'checkpoints', checkpointId, 'review.json')
  const review: Review = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { version: 1, workspace, checkpointId, decisions: {} }
  if (
    review.version !== 1 ||
    review.workspace !== workspace ||
    review.checkpointId !== checkpointId ||
    !review.decisions ||
    typeof review.decisions !== 'object'
  )
    throw new Error('Checkpoint review state is invalid; original data was preserved')
  return { record, review, path }
}
function fingerprint(op: CheckpointFileOp): string {
  const { reversedAt: _reversedAt, ...body } = op as CheckpointFileOp & { reversedAt?: number }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}
function status(review: Review, op: CheckpointFileOp, index: number): CheckpointReviewItem {
  const entry = review.decisions[index]
  if (!entry || entry.fingerprint !== fingerprint(op)) return { opIndex: index, status: 'pending' }
  if (entry.status === 'undoing')
    return {
      opIndex: index,
      status: 'conflicted',
      reason:
        'The previous undo was interrupted. Inspect the file before changing its review decision.'
    }
  if (!['kept', 'undone', 'conflicted'].includes(entry.status))
    throw new Error('Invalid saved review decision')
  return { opIndex: index, status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}) }
}
function save(path: string, review: Review) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(review), { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
const paths = (op: CheckpointFileOp) => (op.kind === 'rename' ? [op.from, op.to] : [op.path])
const overlaps = (a: CheckpointFileOp, b: CheckpointFileOp) =>
  paths(a).some((x) =>
    paths(b).some((y) => x === y || x.startsWith(y + '/') || y.startsWith(x + '/'))
  )
export function checkpointReview(root: string, id: string): CheckpointReviewItem[] {
  const { record, review } = context(root, id)
  return record.ops.map((op, index) => status(review, op, index))
}
/** Caller holds the project write lease; decisions are durable and every operation has its own receipt. */
export function decideCheckpointReview(
  root: string,
  input: CheckpointReviewRequest
): CheckpointReviewItem[] {
  const { record, review, path } = context(root, input.checkpointId)
  if (
    !['keep', 'undo'].includes(input.decision) ||
    !Array.isArray(input.opIndices) ||
    input.opIndices.length > 4096 ||
    input.opIndices.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= record.ops.length)
  )
    throw new Error('Invalid checkpoint review operation')
  const result: CheckpointReviewItem[] = []
  for (const index of [...new Set(input.opIndices)].sort((a, b) => b - a)) {
    const op = record.ops[index],
      current = status(review, op, index)
    if (current.status === 'undone' || current.status === 'kept') {
      result.push(current)
      continue
    }
    const entry = review.decisions[index]
    if (input.decision === 'undo' && entry?.status === 'undoing') {
      result.push(current)
      continue
    }
    const next = (state: Decision['status'], reason?: string) => {
      review.decisions[index] = {
        fingerprint: fingerprint(op),
        status: state,
        ...(reason ? { reason } : {})
      }
      save(path, review)
    }
    if (input.decision === 'keep') next('kept')
    else {
      const later = record.ops.findIndex(
        (other, otherIndex) =>
          otherIndex > index &&
          overlaps(op, other) &&
          status(review, other, otherIndex).status !== 'undone'
      )
      if (later >= 0)
        next(
          'conflicted',
          `A later overlapping operation (${later}) is still applied. Review it before undoing this change.`
        )
      else {
        // Write intent first: a crash cannot cause an automatic duplicate reversal on restart.
        next('undoing')
        try {
          restoreCheckpointOp(root, input.checkpointId, index)
          next('undone')
        } catch (error) {
          next('conflicted', error instanceof Error ? error.message : String(error))
        }
      }
    }
    result.push(status(review, op, index))
  }
  return result
}
