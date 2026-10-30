/**
 * Conservative request accounting without a backend tokenizer. Budgets are kept in
 * ASCII-equivalent units so English and code cost what they always did, while text
 * that tokenizes densely (CJK, emoji, other non-ASCII) pays one token per code unit.
 */
export const CHARS_PER_TOKEN = 3
export const NON_ASCII_CHARS_PER_TOKEN = 1
const NON_ASCII_UNITS = CHARS_PER_TOKEN / NON_ASCII_CHARS_PER_TOKEN

export function contextUnits(text: string): number {
  let units = text.length
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) units += NON_ASCII_UNITS - 1
  return units
}
export const estimateContextTokens = (text: string) =>
  Math.ceil(contextUnits(text) / CHARS_PER_TOKEN)

/** Longest prefix within `units`, never ending inside a surrogate pair. */
function prefixLength(text: string, units: number) {
  let used = 0
  let end = 0
  while (end < text.length) {
    used += text.charCodeAt(end) > 0x7f ? NON_ASCII_UNITS : 1
    if (used > units) break
    end++
  }
  const code = text.charCodeAt(end - 1)
  return end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}
/**
 * Shorten text at a coherent boundary: the last whole line, or the last word of a
 * single long line. A cut never leaves a code fence open, which would turn everything
 * after it into code. Returns '' when no complete unit fits.
 */
export function fitAtBoundary(text: string, units: number): string {
  const end = prefixLength(text, units)
  if (end >= text.length) return text
  const line = text.lastIndexOf('\n', end)
  const word = text.lastIndexOf(' ', end)
  const cut = line > 0 ? line : word > 0 ? word : 0
  const kept = text.slice(0, cut)
  const fences = [...kept.matchAll(/^\s*(?:```|~~~)/gm)]
  if (fences.length % 2 === 0) return kept
  return kept.slice(0, fences[fences.length - 1]!.index).trimEnd()
}
