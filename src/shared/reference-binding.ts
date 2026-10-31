import type { TaskRecommendation } from './task-contract'
import type { ContextHeader } from './context-memory'

/** Canonical source metadata, never additional permission to edit or run. */
export type ReferenceSource = {
  messageId: string
  projectRoot: string | null
  items: Array<{ id: string; digest: string }>
}
export type TaskReferenceBinding = {
  status: 'bound' | 'ambiguous' | 'unavailable'
  remotePolicy: 'recent' | 'opt-in' | 'local-only'
  sources: ReferenceSource[]
  reason?: string
  sourceVersion?: ContextHeader
}
export type ReferenceSourceResult = {
  sourceVersion: ContextHeader | null
  sources: Array<{
    messageId: string
    projectRoot: string | null
    recommendations: TaskRecommendation[]
  }>
}
