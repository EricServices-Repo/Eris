import type { AppSettings } from '../../../../src/shared/settings-schema'
import { resolveModelCapabilities } from '../model-capabilities'
/** Prompt compaction and transport compilation consume the same configured ceiling. */
export function contextBudgetTokens(settings: AppSettings, workerModel: string): number {
  return resolveModelCapabilities(settings, workerModel).promptBudget
}
