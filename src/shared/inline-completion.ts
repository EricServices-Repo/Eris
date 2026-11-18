export const COMPLETION_PREFIX_CHARS = 2400
export const COMPLETION_SUFFIX_CHARS = 800

/** Bounds both prompt assembly and the renderer's outgoing IPC payload. */
export function completionWindow(offset: number, documentLength: number) {
  return {
    start: Math.max(0, offset - COMPLETION_PREFIX_CHARS),
    end: Math.min(documentLength, offset + COMPLETION_SUFFIX_CHARS)
  }
}
