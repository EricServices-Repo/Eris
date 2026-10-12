/**
 * Parse model tool calls — supports <<<TOOL>>> blocks, fenced JSON, and JSON arrays.
 */

export type ToolCall = { name: string; args: Record<string, unknown> }

const TOOL_RE = /<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/gi
const FENCE_RE = /```(?:json|tool)?\s*([\s\S]*?)```/gi

function asTool(obj: unknown): ToolCall | null {
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  const name = String(rec.name || rec.tool || '').trim()
  if (!name) return null
  const args = { ...rec }
  delete args.name
  delete args.tool
  return { name, args }
}

export function parseTools(text: string): ToolCall[] {
  const out: ToolCall[] = []
  const seen = new Set<string>()

  const push = (t: ToolCall | null) => {
    if (!t) return
    const key = `${t.name}:${JSON.stringify(t.args)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }

  TOOL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOOL_RE.exec(text)) !== null) {
    try {
      push(asTool(JSON.parse(m[1]!)))
    } catch {
      // ignore
    }
  }

  FENCE_RE.lastIndex = 0
  while ((m = FENCE_RE.exec(text)) !== null) {
    const body = m[1]!.trim()
    try {
      const parsed = JSON.parse(body) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) push(asTool(item))
      } else {
        push(asTool(parsed))
      }
    } catch {
      // ignore
    }
  }

  // Single-line TOOL_CALL: {...}
  const lineRe = /^\s*TOOL_CALL:\s*(\{[\s\S]*\})\s*$/gm
  while ((m = lineRe.exec(text)) !== null) {
    try {
      push(asTool(JSON.parse(m[1]!)))
    } catch {
      // ignore
    }
  }

  return out
}

export function stripTools(text: string): string {
  return text
    .replace(TOOL_RE, '')
    .replace(FENCE_RE, (full, body: string) => {
      try {
        const parsed = JSON.parse(String(body).trim()) as unknown
        if (asTool(parsed) || (Array.isArray(parsed) && parsed.some((x) => asTool(x)))) {
          return ''
        }
      } catch {
        // keep fence
      }
      return full
    })
    .replace(/^\s*TOOL_CALL:\s*\{[\s\S]*\}\s*$/gm, '')
    .trim()
}

export const SYSTEM_PROMPT = `You are an Eris Cloud Agent working in an isolated workspace.
Call tools using one of these formats (JSON only):

<<<TOOL>>>
{"name":"tree","path":"."}
<<<END>>>

or:

\`\`\`json
{"name":"read_file","path":"src/index.ts"}
\`\`\`

Tools:
- tree — { "name":"tree", "path":".", "maxDepth":3 }
- read_file — { "name":"read_file", "path":"file.ts" }
- write_file — { "name":"write_file", "path":"file.ts", "content":"..." }
- run — { "name":"run", "command":"npm test" }  (sandbox: no sudo/docker/rm -rf /)

Rules:
- Prefer concrete file edits over long plans.
- After TOOL_RESULT, keep going until the goal is done.
- When finished, reply with a short DONE summary and no tools.
- Paths are relative to the workspace root.`
