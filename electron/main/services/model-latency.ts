import type { AppSettings } from '../../../src/shared/settings-schema'

type SampleKind = 'load' | 'warm-answer'
const samples = new Map<string, number[]>()

function key(settings: AppSettings, model: string, kind: SampleKind): string {
  // Native observations are scoped to this process, model and GPU preference.
  return JSON.stringify([
    model,
    settings.models.contextWindow,
    settings.models.preferEgpu,
    settings.models.allowCpuSpill,
    kind
  ])
}

export function recordNativeLatency(
  settings: AppSettings,
  model: string,
  kind: SampleKind,
  elapsedMs: number
): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
  const id = key(settings, model, kind)
  const values = samples.get(id) ?? []
  samples.delete(id)
  samples.set(id, [...values.slice(-15), elapsedMs])
  if (samples.size > 128) samples.delete(samples.keys().next().value!)
}

export function estimatedNativeAnswerMs(
  settings: AppSettings,
  model: string,
  resident: boolean
): number | undefined {
  const median = (kind: SampleKind) => {
    const observed = samples.get(key(settings, model, kind))
    if (!observed || observed.length < 3) return undefined
    return [...observed].sort((a, b) => a - b)[Math.floor(observed.length / 2)]
  }
  const warm = median('warm-answer')
  const load = resident ? 0 : median('load')
  return warm === undefined || load === undefined ? undefined : warm + load
}
