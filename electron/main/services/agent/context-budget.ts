import type { AppSettings } from '../../../../src/shared/settings-schema'
import { findBuiltinEntry, isBuiltinRef } from '../builtin-model'
import { contextLimits } from '../vram-fit'
const COMPACT_BUDGET_RATIO = 0.65
/** Prompt budget before compaction — same window the model was loaded with. */
export function contextBudgetTokens(settings: AppSettings, workerModel: string): number {
  if (isBuiltinRef(workerModel)) {
    const entry = findBuiltinEntry(workerModel)
    const limits = contextLimits({
      tier: entry?.tier,
      role: entry?.role,
      modelContext: entry?.contextWindow,
      settingsContext: settings.models.contextWindow
    })
    return Math.floor(limits.max * COMPACT_BUDGET_RATIO)
  }
  const window = settings.models.contextWindow || 32768
  return Math.floor(Math.min(Math.max(window, 512), 128000) * COMPACT_BUDGET_RATIO)
}
