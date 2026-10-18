import type { LineChange } from '@/shared/line-diff'

let worker: Worker | null = null
let sequence = 0
const pending = new Map<
  number,
  { resolve: (changes: LineChange[]) => void; reject: (error: Error) => void }
>()
const cache = new Map<string, Promise<LineChange[]>>()
export function computeLineChanges(before: string, after: string): Promise<LineChange[]> {
  const key = `${before}\0${after}`
  const hit = cache.get(key)
  if (hit) return hit
  if (!worker) {
    worker = new Worker(new URL('../../workers/diff.worker.ts', import.meta.url), {
      type: 'module'
    })
    worker.onmessage = ({ data }: MessageEvent<{ id: number; changes: LineChange[] }>) => {
      pending.get(data.id)?.resolve(data.changes)
      pending.delete(data.id)
    }
    worker.onerror = () => {
      for (const item of pending.values()) item.reject(new Error('Patch preview worker failed'))
      pending.clear()
      cache.clear()
      worker?.terminate()
      worker = null
    }
  }
  const id = ++sequence
  const result = new Promise<LineChange[]>((resolve, reject) =>
    pending.set(id, { resolve, reject })
  )
  if (key.length < 1_000_000) cache.set(key, result)
  while (cache.size > 4) cache.delete(cache.keys().next().value!)
  worker.postMessage({ id, before, after })
  return result
}
