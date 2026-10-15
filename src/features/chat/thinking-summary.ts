/**
 * Condense raw agent thinking into short activity steps for the chat UI.
 * Keeps the stream insightful without dumping the full log on screen.
 */

const MAX_STEPS = 8
const MAX_STEP_CHARS = 96

/** Lines that are status / tool breadcrumbs (not model monologue). */
const STEP_RE =
  /^(?:—\s+|-\s+|\[\s*(?:ok|error|fail|done)\s*\]\s*)(.+)$/i

/** Noise prefixes to drop entirely. */
const SKIP_RE =
  /^(?:\.{1,3}|…|thinking…|working…|continuing…)$/i

function cleanStep(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').replace(/^TOOL_RESULT\s+/i, '').trim()
  // Tool lines often look like `read_file path: long detail` — keep name + path only.
  const toolDetail = t.match(/^([a-zA-Z0-9_./-]+)(\s+\S+?)?\s*:\s+.+$/)
  if (toolDetail) {
    t = `${toolDetail[1]}${toolDetail[2] || ''}`
  }
  return t.slice(0, MAX_STEP_CHARS)
}

/**
 * Extract a short, de-duplicated step list from a thinking buffer.
 * Prefers explicit status/tool lines; falls back to last non-empty prose lines.
 */
export function summarizeThinkingSteps(thinking: string): string[] {
  const lines = thinking
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const steps: string[] = []
  const seen = new Set<string>()
  const push = (s: string) => {
    const t = cleanStep(s)
    if (!t || SKIP_RE.test(t)) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    steps.push(t)
  }

  for (const line of lines) {
    const m = line.match(STEP_RE)
    if (m?.[1]) push(m[1])
    else if (/^(?:read|edit|wrote|run|verify|list|search|delegat)/i.test(line)) push(line)
  }

  if (steps.length === 0) {
    for (const line of lines) {
      if (line.length < 8) continue
      if (/^[#*`|{]/.test(line)) continue
      push(line)
      if (steps.length >= MAX_STEPS) break
    }
  }

  return steps.slice(-MAX_STEPS)
}

/** One-line preview for the collapsed header. */
export function thinkingPreviewLine(
  thinking: string,
  status?: string | null,
  tools?: Array<{ name: string; path?: string; status: string }>
): string {
  const running = tools?.find((t) => t.status === 'running')
  if (running) {
    return running.path ? `${running.name} ${running.path}` : running.name
  }
  const steps = summarizeThinkingSteps(thinking)
  const lastStep = steps[steps.length - 1] || ''
  const statusText = status?.trim() || ''
  // Prefer a concrete step over a generic Working… status.
  if (lastStep && (!statusText || /^(working|thinking)…?$/i.test(statusText))) {
    return lastStep
  }
  if (statusText) return statusText.slice(0, MAX_STEP_CHARS)
  if (lastStep) return lastStep
  // Live model tokens without breadcrumbs — show a short tail.
  const tail = thinking.trim().replace(/\s+/g, ' ')
  if (tail.length > 12) return tail.slice(-MAX_STEP_CHARS)
  return ''
}
