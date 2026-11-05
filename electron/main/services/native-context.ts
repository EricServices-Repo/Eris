import { stat } from 'node:fs/promises'
import { boundedContextWindow, validContextWindow } from '../../../src/shared/model-context'

// Only load paths read metadata; chat compilation uses this bounded cache without I/O.
const windows = new Map<string, { identity: string; tokens: number }>()
export const nativeContextWindow = (ref: string, fallback: number) =>
  windows.get(ref)?.tokens ?? fallback

export async function discoverNativeContextWindow(
  ref: string,
  path: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  try {
    const file = await stat(path)
    signal?.throwIfAborted()
    const identity = `${path}:${file.size}:${file.mtimeMs}`
    if (windows.get(ref)?.identity === identity) return
    windows.delete(ref)
    const { readGgufFileInfo } = await import('node-llama-cpp')
    const { metadata } = await readGgufFileInfo(path, {
      sourceType: 'filesystem',
      readTensorInfo: false,
      spliceSplitFiles: false,
      ignoreKeys: [
        'tokenizer.ggml.tokens',
        'tokenizer.ggml.merges',
        'tokenizer.ggml.scores',
        'tokenizer.ggml.token_type'
      ],
      logWarnings: false,
      signal
    })
    signal?.throwIfAborted()
    const fields = metadata as unknown as Record<string, Record<string, unknown>>
    const architecture = fields.general?.architecture
    const tokens =
      typeof architecture === 'string' ? fields[architecture]?.context_length : undefined
    if (!validContextWindow(tokens)) return
    if (windows.size >= 128) windows.delete(windows.keys().next().value!)
    windows.set(ref, { identity, tokens: boundedContextWindow(tokens) })
  } catch {
    signal?.throwIfAborted()
    windows.delete(ref) // Missing/unreadable metadata retains the conservative catalog limit.
  }
}
