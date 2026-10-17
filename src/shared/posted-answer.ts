/** Lift a real reply out of the thinking trace when the saved body is only a tool log. */
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
  const toolLog = /^Finished:/m.test(body) && /What I did:/.test(body)
  if (prose.length >= 40 && (toolLog || prose.length > body.length + 40)) return prose
  return content
}
