import { createHash } from 'crypto'
import { statSync } from 'fs'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { findLocalEntry, localModelFilePath } from './local-model'
import { findBuiltinEntry, localModelPath } from './builtin-model'
import { resolveConnectionForModel } from './model-catalog'
import { toolProtocolFor } from './tool-protocol'

export const ROUTING_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** No prompt content or credentials. A file replacement or endpoint/protocol change invalidates scores. */
export function routingEvidenceKey(settings: AppSettings, model: string): string {
  let identity: unknown
  if (/^(local:|builtin:)/.test(model)) {
    const local = model.startsWith('local:') ? findLocalEntry(model) : null
    const builtin = model.startsWith('builtin:') ? findBuiltinEntry(model) : null
    const entry = local || builtin
    let file: unknown = null
    try {
      const path = local ? localModelFilePath(local) : builtin ? localModelPath(builtin) : ''
      const stat = statSync(path)
      file = [stat.size, stat.mtimeMs]
    } catch { /* absent weights cannot reuse a prior installation's measurements */ }
    identity = [entry?.sha256, file, entry?.contextWindow]
  } else {
    const c = resolveConnectionForModel(settings, model)
    identity = [c?.id, c?.baseUrl, c?.provider]
  }
  return createHash('sha256').update(JSON.stringify([
    'auto-routing-v1', model, identity, settings.models.contextWindow, toolProtocolFor(settings, model)
  ])).digest('hex')
}
