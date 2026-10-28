import { createHash } from 'crypto'
import { atomicEvidenceJson, readEvidence, saveEvidenceOwner } from './evidence-records'
import { parsePersistedTask } from './evidence-schemas'
import { join } from 'path'
import type { TaskContract } from '../../../src/shared/task-contract'
import { userDataRoot } from './paths'

function threadKey(root: string | null, thread: string): string {
  return createHash('sha256')
    .update(JSON.stringify([root, thread]))
    .digest('hex')
}
export function previousTask(root: string | null, thread: string | null): TaskContract | undefined {
  if (!thread) return undefined
  const task = readEvidence(
    join(userDataRoot(), 'task-contracts', threadKey(root, thread) + '.json'),
    parsePersistedTask
  )
  return task && task.threadId === thread && task.scope.workspaceRoot === root ? task : undefined
}
export function saveTask(task: TaskContract): void {
  if (!task.threadId) return
  const checked = parsePersistedTask(task)
  saveEvidenceOwner({
    version: 1,
    taskId: checked.taskId,
    threadId: checked.threadId,
    root: checked.scope.workspaceRoot,
    terminal: checked.result?.terminal === 'complete'
  })
  atomicEvidenceJson(
    join(
      userDataRoot(),
      'task-contracts',
      threadKey(task.scope.workspaceRoot, task.threadId) + '.json'
    ),
    checked
  )
}
