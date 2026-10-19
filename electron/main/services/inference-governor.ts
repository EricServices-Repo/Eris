import { freemem, totalmem } from 'os'

export type InferenceWorkload = 'text' | 'image' | 'embedding' | 'index'

export type InferenceLease = {
  id: number
  workload: InferenceWorkload
  reservedBytes: number
  release: () => void
}

type Request = {
  id: number
  workload: InferenceWorkload
  requestedBytes: number
  gpu: boolean
  exclusiveGpu: boolean
  priority: number
  signal?: AbortSignal
  resolve: (lease: InferenceLease) => void
  reject: (error: Error) => void
}

type Active = Pick<Request, 'id' | 'workload' | 'requestedBytes' | 'gpu' | 'exclusiveGpu'>

let sequence = 0
const pending: Request[] = []
const active = new Map<number, Active>()

function abortError(): Error {
  const error = new Error('Aborted while waiting for local inference resources')
  error.name = 'AbortError'
  return error
}

function memoryReserve(): number {
  const total = totalmem()
  return Math.max(2 * 1024 ** 3, Math.floor(total * (process.platform === 'darwin' ? 0.25 : 0.15)))
}

function canStart(request: Request): boolean {
  const reserved = [...active.values()].reduce((sum, item) => sum + item.requestedBytes, 0)
  const capacity = Math.max(0, totalmem() - memoryReserve())
  if (request.requestedBytes + reserved > capacity) return false
  // A single workload owns the device and performs its own detailed load-time checks.
  // Free memory is most useful while deciding whether two workloads may overlap.
  if (active.size > 0 && request.requestedBytes > Math.max(0, freemem() - memoryReserve()))
    return false
  if (!request.gpu) return true
  const gpuActive = [...active.values()].filter((item) => item.gpu)
  if (request.exclusiveGpu) return gpuActive.length === 0
  return !gpuActive.some((item) => item.exclusiveGpu)
}

function drain(): void {
  pending.sort((a, b) => b.priority - a.priority || a.id - b.id)
  for (let i = 0; i < pending.length;) {
    const request = pending[i]!
    if (request.signal?.aborted) {
      pending.splice(i, 1)
      request.reject(abortError())
      continue
    }
    if (!canStart(request)) {
      i += 1
      continue
    }
    pending.splice(i, 1)
    active.set(request.id, {
      id: request.id,
      workload: request.workload,
      requestedBytes: request.requestedBytes,
      gpu: request.gpu,
      exclusiveGpu: request.exclusiveGpu
    })
    let released = false
    request.resolve({
      id: request.id,
      workload: request.workload,
      reservedBytes: request.requestedBytes,
      release: () => {
        if (released) return
        released = true
        active.delete(request.id)
        queueMicrotask(drain)
      }
    })
  }
}

export function acquireInferenceLease(options: {
  workload: InferenceWorkload
  requestedBytes: number
  gpu?: boolean
  exclusiveGpu?: boolean
  priority?: number
  signal?: AbortSignal
}): Promise<InferenceLease> {
  if (options.signal?.aborted) return Promise.reject(abortError())
  const requestedBytes = Math.max(0, Math.floor(options.requestedBytes))
  const capacity = Math.max(0, totalmem() - memoryReserve())
  if (requestedBytes > capacity) {
    return Promise.reject(
      new Error(
        `${options.workload} model needs about ${(requestedBytes / 1024 ** 3).toFixed(1)} GB, but this system can safely reserve ${(capacity / 1024 ** 3).toFixed(1)} GB.`
      )
    )
  }
  return new Promise((resolve, reject) => {
    const request: Request = {
      id: ++sequence,
      workload: options.workload,
      requestedBytes,
      gpu: options.gpu !== false,
      exclusiveGpu: options.exclusiveGpu !== false,
      priority: options.priority ?? (options.workload === 'text' ? 20 : 10),
      signal: options.signal,
      resolve,
      reject
    }
    const onAbort = () => {
      const index = pending.indexOf(request)
      if (index >= 0) pending.splice(index, 1)
      reject(abortError())
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const originalResolve = request.resolve
    request.resolve = (lease) => {
      options.signal?.removeEventListener('abort', onAbort)
      originalResolve(lease)
    }
    pending.push(request)
    drain()
  })
}

export function inferenceGovernorStatus(): {
  active: Array<{ workload: InferenceWorkload; reservedBytes: number; gpu: boolean }>
  queued: Array<{ workload: InferenceWorkload; requestedBytes: number }>
} {
  return {
    active: [...active.values()].map((item) => ({
      workload: item.workload,
      reservedBytes: item.requestedBytes,
      gpu: item.gpu
    })),
    queued: pending.map((item) => ({
      workload: item.workload,
      requestedBytes: item.requestedBytes
    }))
  }
}
