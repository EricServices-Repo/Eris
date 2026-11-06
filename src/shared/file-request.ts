import { pathsIn } from './recommendations'
import { effectConstraints, requestTextForIntent } from './task-interpretation'

export type FileRequest = {
  state: 'resolved' | 'missing' | 'ambiguous'
  paths: string[]
}

/** An explicit file-creation instruction, not a quoted example or an approach question. */
export function fileCreationRequest(text: string): { referenced: boolean; paths: string[] } | null {
  const t = requestTextForIntent(text)
  if (effectConstraints(text).edit) return null
  if (!/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:generate|create|write|save)\b/i.test(t))
    return null
  // A chat destination is explicit even when a filename is used as an example.
  if (/\b(?:in (?:the )?chat|as (?:an? )?example|show me|do not save|don't save)\b/i.test(t)) return null
  const referenced = /\b(?:those|these|the listed|the proposed)\s+files\b/i.test(t)
  const paths = pathsIn(t)
  return referenced || paths.length ? { referenced, paths } : null
}

/**
 * Pure bounded intake. A validated historical binding takes precedence; unresolved
 * bindings never fall back to incidental filenames in prose. Multiple recent file
 * sets remain ambiguous. These names are operands, never authority or evidence that
 * files exist. The runtime still validates project identity and every tool effect.
 */
export function resolveFileRequest(
  text: string,
  history: ReadonlyArray<{ role: string; content: string }> = [],
  reference?: { status: 'bound' | 'ambiguous' | 'unavailable'; paths: string[] }
): FileRequest | null {
  const request = fileCreationRequest(text)
  if (!request) return null
  if (!request.referenced) return request.paths.length > 100
    ? { state: 'ambiguous', paths: [] } : { state: 'resolved', paths: request.paths }
  if (reference) {
    if (reference.status !== 'bound')
      return { state: reference.status === 'ambiguous' ? 'ambiguous' : 'missing', paths: [] }
    const paths = [...new Set(reference.paths)]
    return paths.length > 100 ? { state: 'ambiguous', paths: [] }
      : { state: paths.length ? 'resolved' : 'missing', paths }
  }
  const candidates = new Map<string, string[]>()
  for (const message of history.slice(-6)) {
    if (message.role !== 'assistant') continue
    // Do not infer a proposal from pasted logs, code or block quotes.
    const prose = message.content.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/^\s*>.*$/gm, '')
    if (!/\b(?:create|generate|write|add|proposed|planned|files to|files:)\b/i.test(prose)) continue
    const paths = pathsIn(prose).sort()
    if (paths.length) candidates.set(JSON.stringify(paths), paths)
  }
  return candidates.size === 1 && [...candidates.values()][0]!.length <= 100
    ? { state: 'resolved', paths: [...candidates.values()][0]! }
    : { state: candidates.size ? 'ambiguous' : 'missing', paths: [] }
}
