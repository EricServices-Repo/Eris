import type { ChatJobEvent } from './chat-jobs'

/** A bounded view of observed events, not inferred task or requirement completion. */
export function observedChatProgress(events: readonly ChatJobEvent[]) {
  let lastSuccess: { name: string; path?: string } | undefined
  let lastFailure: { name: string; code?: string; repeats: number } | undefined
  let verification: { command?: string; result: 'passed' | 'failed' } | undefined
  const changed = new Set<string>()
  let previousFailureKey: string | undefined
  for (const event of events) {
    if (event.channel === 'chat:diff') {
      const diff = event.payload.diff as { path?: unknown; op?: unknown } | undefined
      if (typeof diff?.path === 'string' && diff.path.length <= 4096 &&
          ['write', 'delete', 'rename', 'mkdir', 'binary'].includes(String(diff.op)))
        { changed.add(diff.path); verification = undefined }
    }
    if (event.channel !== 'chat:tool') continue
    const tool = event.payload.tool as { name?: unknown; status?: unknown; path?: unknown; failure?: { code?: unknown } } | undefined
    if (typeof tool?.name !== 'string' || tool.name.length > 200) continue
    const path = typeof tool.path === 'string' && tool.path.length <= 4096 ? tool.path : undefined
    if (tool.status === 'ok') {
      previousFailureKey = undefined
      lastSuccess = { name: tool.name, ...(path ? { path } : {}) }
      if (tool.name === 'verify') verification = { command: path, result: 'passed' }
    } else if (tool.status === 'error') {
      const code = typeof tool.failure?.code === 'string' ? tool.failure.code.slice(0, 100) : undefined
      const key = `${tool.name}\0${code ?? ''}`
      const repeats = previousFailureKey === key ? (lastFailure?.repeats ?? 0) + 1 : 1
      previousFailureKey = key
      lastFailure = { name: tool.name, ...(code ? { code } : {}), repeats }
      if (tool.name === 'verify') verification = { command: path, result: 'failed' }
    }
  }
  return { lastSuccess, lastFailure, changedFiles: [...changed].slice(-20), verification }
}
