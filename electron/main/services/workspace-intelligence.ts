import { findSymbols, relatedFiles } from './code-index'
import { type RetrieveResult, retrieveContextAsync } from './workspace-search'
import { shouldSkipWorkspacePath } from './workspace-ignore'

export type WorkspaceIntelligenceResult = {
  provenance?: RetrieveResult['provenance']
  ok: boolean
  detail: string
  paths: string[]
  reasons: Array<{ path: string; signals: string[] }>
}

function querySymbols(query: string): string[] {
  return [...query.matchAll(/`([A-Za-z_$][\w$]*)`|\b([A-Za-z_$][\w$]{3,})\b/g)]
    .map((match) => match[1] || match[2] || '')
    .filter((term) => !/^(this|that|with|from|have|what|where|which|project|code)$/i.test(term))
    .slice(0, 3)
}

/** One retrieval boundary for chat, search UI, and future index implementations. */
export async function inspectWorkspace(
  workspacePath: string,
  query: string,
  maxFiles = 8
): Promise<WorkspaceIntelligenceResult> {
  const symbols = querySymbols(query)
  const [retrieval, symbolResults] = await Promise.all([
    retrieveContextAsync(workspacePath, query, maxFiles),
    Promise.all(symbols.map((symbol) => findSymbols(workspacePath, symbol, 8).catch(() => null)))
  ])
  const symbolHits = symbolResults
    .flatMap((result) => result?.hits ?? [])
    .filter((hit) => !shouldSkipWorkspacePath(workspacePath, hit.path))
  const seedPath = retrieval.paths[0] || symbolHits[0]?.path
  const related = seedPath ? await relatedFiles(workspacePath, seedPath, 6).catch(() => null) : null
  const paths = [
    ...new Set([
      ...retrieval.paths,
      ...symbolHits.map((hit) => hit.path),
      ...(related?.paths ?? [])
    ])
  ]
    .filter((path) => !shouldSkipWorkspacePath(workspacePath, path))
    .slice(0, maxFiles)
  const reasons = paths.map((path) => {
    const signals: string[] = []
    if (retrieval.paths.includes(path)) signals.push('content and path relevance')
    if (symbolHits.some((hit) => hit.path === path)) signals.push('symbol match')
    if (related?.paths.includes(path)) signals.push(`related to ${seedPath}`)
    return { path, signals }
  })
  const extra = symbolHits.length
    ? `\n\n[Symbol matches]\n${symbolHits
        .slice(0, 12)
        .map((hit) => `${hit.kind} ${hit.name} — ${hit.path}:${hit.line}`)
        .join('\n')}`
    : ''
  return {
    provenance: retrieval.provenance,
    ok: retrieval.ok,
    detail: `${retrieval.detail}${extra}`,
    paths,
    reasons
  }
}
