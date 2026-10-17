/** Lift a real reply out of the thinking trace when the saved body is only a tool log. */
export function isToolLogReply(text: string): boolean {
  const body = text.trim()
  if (!body) return true
  if (/What I did:/.test(body) && /^Finished:/m.test(body)) return true
  if (/Failed read_file/i.test(body) && /Inspected /.test(body)) return true
  return false
}

export function promoteThinkingToAnswer(content: string, thinking: string): string {
  const prose = thinking
    .replace(/<<<TOOL>>>[\s\S]*?<<<END>>>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('—') && !trimmed.startsWith('{')
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const body = content.trim()
  if (prose.length >= 40 && !isToolLogReply(prose) && (isToolLogReply(body) || prose.length > body.length + 40)) {
    return prose
  }
  return content
}

/** Keep tool progress in Thinking. The reply itself belongs in the message. */
export function stripAnswerFromThinking(thinking: string, answer: string): string {
  const body = answer.trim()
  let trace = thinking.trim()
  if (!trace) return ''
  if (body && trace.includes(body)) trace = trace.replace(body, '')
  trace = trace
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (body && line === body) return false
      if (body && body.includes(line) && line.length > 80) return false
      return true
    })
    .join('\n')
    .trim()
  return trace
}
