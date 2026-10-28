import { pinEvidence, storageFailure } from './evidence-records'
import { createHash } from 'crypto'
import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { userDataRoot } from './paths'
import { logWarn } from './logger'
import { activeDiagnosticsScope } from './model-transport'
const pending = new Map<string, Promise<void>>()
const failures = new Map<string, Error>()
const sequence = new Map<string, number>()
/** Durable metadata ledger. Source content remains in the existing checkpoints. */
export function appendTaskEvent(taskId: string, type: string, data: unknown): void {
  const diagnostics = activeDiagnosticsScope()
  const listener = diagnostics?.onTaskEvent
  if (listener) {
    try {
      listener({ taskId, type, data: structuredClone(data) })
    } catch {
      /* a diagnostics listener never affects the ledger */
    }
  }
  if (diagnostics) return // Diagnostic event capture owns its evidence; never pollute production ledgers.
  const unpin = pinEvidence()
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
      const failure = new Error(
        'Task evidence storage failed; inspect Storage in Settings before relying on recovery'
      )
      failures.set(taskId, failure)
      storageFailure(join(directory, filename), error)
      logWarn('Task ledger write failed', {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  pending.set(taskId, write.finally(unpin))
}
export async function flushTaskLedger(taskId: string): Promise<void> {
  await pending.get(taskId)
  pending.delete(taskId)
  sequence.delete(taskId)
  const failure = failures.get(taskId)
  failures.delete(taskId)
  if (failure) throw failure
}
