/** Fixed-size chunks, sequential cases: bounded GPU load and durable per-case checkpoints. */
export async function* questionBatches(total: number, start: number, signal: AbortSignal) {
  for (let offset = start; offset < total && !signal.aborted;) {
    const end = Math.min(total, (Math.floor(offset / 10) + 1) * 10)
    yield {
      number: Math.floor(offset / 10) + 1,
      total: Math.ceil(total / 10),
      size: 10 as const,
      indices: Array.from({ length: end - offset }, (_, i) => offset + i)
    }
    offset = end
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
