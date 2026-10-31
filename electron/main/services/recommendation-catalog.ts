import { realpathAllowMissing } from './workspace-boundary'
import { createHash } from 'crypto'
import { join } from 'path'
import { z } from 'zod'
import { atomicEvidenceJson, readEvidence } from './evidence-records'
import { userDataRoot } from './paths'
import type { TaskContract, TaskRecommendation } from '../../../src/shared/task-contract'
import type { ReferenceSource } from '../../../src/shared/reference-binding'
const source = z
  .object({
    messageId: z.string().min(1).max(256),
    projectRoot: z.string().max(4096).nullable(),
    items: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{16}$/),
            digest: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .max(100)
  })
  .strict()
const catalog = z.array(source).max(64)
const pathFor = (root: string | null, threadId: string) =>
  join(
    userDataRoot(),
    'recommendation-catalogs',
    createHash('sha256')
      .update(JSON.stringify([root ? realpathAllowMissing(root) : null, threadId]))
      .digest('hex') + '.json'
  )
export const referenceItemDigest = (item: TaskRecommendation) =>
  createHash('sha256')
    .update(JSON.stringify([item.id, item.text, item.targets ?? [], item.section ?? '']))
    .digest('hex')
export function recommendationSources(root: string | null, threadId: string): ReferenceSource[] {
  return readEvidence(pathFor(root, threadId), (value) => catalog.parse(value)) ?? []
}
export function recordRecommendationSource(task: TaskContract): void {
  if (!task.threadId || !task.result?.offeredRecommendations.length) return
  const root = task.scope.workspaceRoot
  const next: ReferenceSource = {
    messageId: `${task.taskId}:assistant`,
    projectRoot: task.scope.projectRoot,
    items: task.result.offeredRecommendations
      .slice(0, 100)
      .map((item) => ({ id: item.id, digest: referenceItemDigest(item) }))
  }
  const sources = [
    ...recommendationSources(root, task.threadId).filter((s) => s.messageId !== next.messageId),
    next
  ].slice(-64)
  // No answer text is copied; canonical SQLite remains the only source owner.
  while (sources.length > 1 && Buffer.byteLength(JSON.stringify(sources)) > 512 * 1024)
    sources.shift()
  atomicEvidenceJson(pathFor(root, task.threadId), catalog.parse(sources))
}
