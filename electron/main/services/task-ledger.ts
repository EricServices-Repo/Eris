import { createHash } from 'crypto'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { userDataRoot } from './paths'
import { logWarn } from './logger'
import { activeDiagnosticsScope } from './model-transport'
const pending = new Map<string, Promise<void>>()
const sequence = new Map<string, number>()
/** Durable metadata ledger. Source content remains in the existing checkpoints. */
export function appendTaskEvent(taskId: string, type: string, data: unknown): void {
  const listener = activeDiagnosticsScope()?.onTaskEvent
  if (listener) {
    try {
      listener({ taskId, type, data: structuredClone(data) })
    } catch {
      /* a diagnostics listener never affects the ledger */
    }
  }
  const next = (sequence.get(taskId) ?? 0) + 1
  sequence.set(taskId, next)
  const body =
    JSON.stringify({ taskId, sequence: next, at: new Date().toISOString(), type, data }) + '\n'
  const directory = join(userDataRoot(), 'task-ledger')
  const filename = createHash('sha256').update(taskId).digest('hex') + '.jsonl'
  const write = (pending.get(taskId) ?? Promise.resolve())
    .then(async () => {
      await mkdir(directory, { recursive: true })
      await appendFile(join(directory, filename), body, 'utf8')
    })
    .catch((error) => {
      logWarn('Task ledger write failed', {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  pending.set(taskId, write)
}
export async function flushTaskLedger(taskId: string): Promise<void> {
  await pending.get(taskId)
  pending.delete(taskId)
  sequence.delete(taskId)
}
