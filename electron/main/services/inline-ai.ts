import type { AppSettings } from '../../../src/shared/settings-schema'
import { streamModelChat } from './chat-runtime'

function collectText(
  gen: AsyncGenerator<string, void, unknown>
): Promise<string> {
  return (async () => {
    let out = ''
    for await (const chunk of gen) out += chunk
    return out.trim()
  })()
}

/** Ghost-text / Tab completion suggestion at the cursor. */
export async function completeAtCursor(options: {
  settings: AppSettings
  getSecret: (key: string) => string | null
  path: string
  language: string
  prefix: string
  suffix: string
  signal?: AbortSignal
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const prefix = options.prefix.slice(-2400)
  const suffix = options.suffix.slice(0, 800)
  const model = options.settings.models.defaultModel || 'builtin:composer-lite'
  try {
    const text = await collectText(
      streamModelChat({
        settings: options.settings,
        model,
        temperature: Math.min(0.2, options.settings.models.temperature),
        getSecret: options.getSecret,
        signal: options.signal,
        messages: [
          {
            role: 'system',
            content:
              'You are Eris’s inline code completion engine.\n' +
              'Continue the code at the cursor so it fits the surrounding file.\n' +
              'Match indentation, naming, and style from the prefix.\n' +
              'Reply with ONLY the completion text to insert — no markdown fences, no explanations, no repeating the prefix.'
          },
          {
            role: 'user',
            content: [
              `File: ${options.path} (${options.language})`,
              'Code before cursor:',
              prefix,
              '⟨cursor⟩',
              'Code after cursor:',
              suffix || '(eof)',
              '',
              'Write the next 1–12 lines (or the rest of the current expression) that belong at ⟨cursor⟩.',
              'Stop before duplicating code that already exists after the cursor.'
            ].join('\n')
          }
        ]
      })
    )
    const cleaned = text
      .replace(/^```[\w]*\n?/, '')
      .replace(/\n?```$/, '')
      .replace(/^⟨?cursor⟩?/i, '')
    if (!cleaned) return { ok: false, error: 'Empty completion' }
    return { ok: true, text: cleaned.slice(0, 2000) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Selection or instruction-based inline edit. Returns full new selection text. */
export async function inlineEdit(options: {
  settings: AppSettings
  getSecret: (key: string) => string | null
  path: string
  language: string
  selection: string
  instruction: string
  before?: string
  after?: string
  signal?: AbortSignal
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const model = options.settings.models.defaultModel || 'builtin:composer-lite'
  const selection = options.selection.slice(0, 12_000)
  if (!selection.trim() && !options.instruction.trim()) {
    return { ok: false, error: 'Select code or provide an instruction' }
  }
  try {
    const text = await collectText(
      streamModelChat({
        settings: options.settings,
        model,
        temperature: Math.min(0.3, options.settings.models.temperature),
        getSecret: options.getSecret,
        signal: options.signal,
        messages: [
          {
            role: 'system',
            content:
              'You are Eris’s inline code editor.\n' +
              'Apply the user instruction to the selection and return ONLY the replacement code ' +
              '(or the full snippet if there is no selection).\n' +
              'Preserve surrounding style and imports unless the instruction requires changes.\n' +
              'No markdown fences, no commentary, no explanations.'
          },
          {
            role: 'user',
            content: [
              `File: ${options.path} (${options.language})`,
              `Instruction: ${options.instruction || 'Improve this code for clarity and correctness'}`,
              options.before ? `Context before:\n${options.before.slice(-800)}` : '',
              'Selection to replace:',
              selection || '(empty — insert new code at this location)',
              options.after ? `Context after:\n${options.after.slice(0, 800)}` : '',
              'Return only the new selection text.'
            ]
              .filter(Boolean)
              .join('\n\n')
          }
        ]
      })
    )
    const cleaned = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')
    if (!cleaned) return { ok: false, error: 'Empty edit result' }
    return { ok: true, text: cleaned }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
