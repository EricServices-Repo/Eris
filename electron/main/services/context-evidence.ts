import type { ContextEvidence } from '../../../src/shared/context-evidence'
import type { MemoryPrompt } from '../../../src/shared/context-memory'
import { evidenceEpoch, evidenceEpochMatches } from './context-evidence-epochs'
import { workspaceRequest } from './workspace-worker-client'
import { abortable } from './context-hydration'
import { MEMORY_PROMPT_HEADER } from './context-memory-store'
export async function captureReceiptEvidence(
  root: string,
  paths: string[]
): Promise<ContextEvidence | undefined> {
  const before = evidenceEpoch(root, paths)
  try {
    const snapshot = await abortable(
      workspaceRequest({ type: 'context-evidence-capture', root, paths: paths.slice(0, 33) }),
      [AbortSignal.timeout(1000)]
    )
    const epoch = evidenceEpoch(
      root,
      snapshot.files.map((f) => f.path)
    )
    return {
      ...snapshot,
      epoch,
      complete:
        snapshot.complete &&
        paths.length <= 32 &&
        !epoch.dirty &&
        JSON.stringify(before) === JSON.stringify(epoch)
    }
  } catch {
    return undefined
  }
}
export async function invalidEvidenceItems(
  root: string | null,
  items: NonNullable<MemoryPrompt['items']>,
  signal?: AbortSignal
) {
  const selected = items.filter((item) => item.dependencies)
  if (!selected.length) return new Set<string>()
  if (!root) return new Set(selected.map((item) => item.id))
  try {
    const valid = await abortable(
      workspaceRequest({
        type: 'context-evidence-validate',
        root,
        snapshots: selected.map((item) => item.dependencies!)
      }),
      [AbortSignal.timeout(150), signal]
    )
    return new Set(
      selected
        .filter((item, i) => !valid[i] || !evidenceEpochMatches(item.dependencies!))
        .map((item) => item.id)
    )
  } catch {
    signal?.throwIfAborted()
    return new Set(selected.map((item) => item.id))
  }
}
export async function filterEvidenceMemory(
  root: string | null,
  prompt: MemoryPrompt,
  signal?: AbortSignal
): Promise<MemoryPrompt> {
  const items = prompt.items ?? [],
    invalid = await invalidEvidenceItems(root, items, signal)
  if (!invalid.size) return prompt
  const kept = items.filter((item) => !invalid.has(item.id))
  const text = kept.length ? MEMORY_PROMPT_HEADER + kept.map((item) => item.line).join('') : ''
  return {
    ...prompt,
    items: kept,
    text,
    manifest: {
      ...prompt.manifest,
      selectedIds: kept.map((item) => item.id),
      sourceIds: prompt.manifest.sourceIds.filter((_id, i) => !invalid.has(items[i]?.id)),
      estimatedTokens: Math.ceil(text.length / 3),
      omittedFacts: prompt.manifest.omittedFacts + invalid.size,
      reason:
        'Stale or unverified code/test dependency snapshots were excluded; user preferences remain eligible.'
    }
  }
}
