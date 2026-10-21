import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
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
  try {
    const task = JSON.parse(
      readFileSync(
        join(userDataRoot(), 'task-contracts', threadKey(root, thread) + '.json'),
        'utf8'
      )
    ) as TaskContract
    return task.version === 2 && task.threadId === thread && task.scope.workspaceRoot === root
      ? task
      : undefined
  } catch {
    return undefined
  }
}
export function saveTask(task: TaskContract): void {
  if (!task.threadId) return
  const directory = join(userDataRoot(), 'task-contracts')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, threadKey(task.scope.workspaceRoot, task.threadId) + '.json')
  writeFileSync(path + '.tmp', JSON.stringify(task), 'utf8')
  renameSync(path + '.tmp', path)
}
