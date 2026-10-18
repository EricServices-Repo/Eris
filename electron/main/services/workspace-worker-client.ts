import { Worker } from 'worker_threads'
import { join } from 'path'
import { app } from 'electron'
import type { WorkspaceRequest, WorkspaceReply, WorkspaceResult } from './workspace-worker-protocol'

type Lane = 'io' | 'index' | 'chat'
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const lanes = new Map<Lane, { worker: Worker; pending: Map<number, Pending> }>()
let sequence = 0
let stopping = false

/** Separate queues keep repository indexing from delaying file opens or chat saves. */
export function workspaceRequest<T extends WorkspaceRequest>(
  request: T
): Promise<WorkspaceResult<T>> {
  if (stopping) return Promise.reject(new Error('Eris is shutting down'))
  const lane: Lane = request.type.startsWith('chat-')
    ? 'chat'
    : request.type === 'index' || request.type === 'patch-index'
      ? 'index'
      : 'io'
  let state = lanes.get(lane)
  if (!state) {
    const worker = new Worker(join(__dirname, 'workspace-worker.js'), {
      env: {
        ...process.env,
        ERIS_RESOURCES_PATH: process.resourcesPath,
        ERIS_APP_PATH: app.getAppPath()
      }
    })
    const pending = new Map<number, Pending>()
    state = { worker, pending }
    lanes.set(lane, state)
    const fail = (error: Error) => {
      if (lanes.get(lane)?.worker === worker) lanes.delete(lane)
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }
    worker.on('message', (reply: WorkspaceReply) => {
      const entry = pending.get(reply.id)
      if (!entry) return
      pending.delete(reply.id)
      clearTimeout(entry.timer)
      if (reply.error) entry.reject(new Error(reply.error))
      else entry.resolve(reply.result)
      if (!pending.size) worker.unref()
    })
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`Workspace ${lane} worker exited (${code})`)))
    worker.unref()
  }
  const { worker, pending } = state
  worker.ref()
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(
      () => {
        // A dead worker must not leave queued reads or writes hanging forever.
        void worker.terminate()
      },
      lane === 'index' ? 180_000 : 60_000
    )
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    worker.postMessage({ id, request })
  })
}

export async function disposeWorkspaceWorkers(): Promise<void> {
  stopping = true
  await Promise.all(
    [...lanes.values()].map(async ({ worker, pending }) => {
      // Drain queued writes and close WAL files before terminating the worker.
      await new Promise<void>((resolve) => {
        const id = ++sequence
        const timer = setTimeout(resolve, 5000)
        pending.set(id, {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: () => {
            clearTimeout(timer)
            resolve()
          },
          timer
        })
        worker.ref()
        worker.postMessage({ id, request: { type: 'shutdown' } })
      })
      await worker.terminate()
    })
  )
  lanes.clear()
}
