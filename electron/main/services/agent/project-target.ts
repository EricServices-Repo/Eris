/** Extract a named target as a retrieval hint; task intake verifies it against project metadata. */
export function namedProjectTarget(goal: string): string | null {
  const match = goal.match(
    /\b(?:for|of|in|on)\s+the\s+([A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*){0,2})\s+(?:website|site|app|application|project)\b/i
  )
  const direct = goal.match(
    /\b(?:review|inspect|improve|fix|update|edit)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]*)\s+(?:website|site|app|application|project)\b/i
  )
  const found = match ?? direct
  if (!found) return null
  const target = found[1]!.trim()
  return /^(?:this|that|my|our|your|current|existing|new|same|other|client|user|whole|entire|local|web)$/i.test(
    target
  )
    ? null
    : target
}
