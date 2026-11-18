import type { AppSettings } from './settings-schema'

export type ModelCapabilityProfile = AppSettings['models']['capabilityProfiles'][string]

export interface ModelCapabilityEvidence extends Partial<ModelCapabilityProfile> {
  parametersBillions?: number
}

export function parameterBillions(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value / 1e9
  if (typeof value !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([bm])$/i.exec(value.trim())
  return match ? Number(match[1]) / (match[2].toLowerCase() === 'm' ? 1000 : 1) : undefined
}

/** Maximum mode is opt-in; disabling the profile restores existing sizing. */
export function usesModelMaximum(settings: AppSettings, model: string): boolean {
  const profile = settings.models.capabilityProfiles?.[model]
  return profile?.enabled !== false && profile?.contextWindowMode === 'model-maximum'
}
