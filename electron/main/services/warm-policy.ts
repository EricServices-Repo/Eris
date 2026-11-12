/** Decide whether an idle warm may replace a recently used resident model. */
export function idleWarmDecision(input: {
  residentPath: string | null
  targetPath: string
  residentRequestedContext: number
  targetRequestedContext: number
  residentUsedByChatMsAgo: number | null
}): 'skip-recently-used-model-resident' | 'already-warm' | 'load' {
  if (input.residentPath === input.targetPath && input.residentRequestedContext === input.targetRequestedContext)
    return 'already-warm'
  if (input.residentPath && input.residentPath !== input.targetPath &&
      input.residentUsedByChatMsAgo !== null && input.residentUsedByChatMsAgo >= 0 &&
      input.residentUsedByChatMsAgo < 10 * 60_000)
    return 'skip-recently-used-model-resident'
  return 'load'
}
