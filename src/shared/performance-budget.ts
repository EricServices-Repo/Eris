export function performanceQuantiles(values: number[]) {
  const samples = values.filter((n) => Number.isFinite(n) && n >= 0),
    sorted = [...samples].sort((a, b) => a - b)
  const at = (p: number) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null
  return { samples, p50: at(0.5), p95: at(0.95) }
}
export function evaluatePerformanceBudget(
  hardware: { platform: string; arch: string; cpu?: string; totalMemoryBytes: number },
  metrics: Record<string, unknown>,
  profiles: Array<{
    id: string
    platform: string
    arch: string
    cpu: string
    minMemoryBytes: number
    maxMemoryBytes: number
    limits: Record<string, { p50: number; p95: number }>
  }>
) {
  const profile = profiles.find(
    (p) =>
      p.platform === hardware.platform &&
      p.arch === hardware.arch &&
      p.cpu === hardware.cpu &&
      hardware.totalMemoryBytes >= p.minMemoryBytes &&
      hardware.totalMemoryBytes <= p.maxMemoryBytes
  )
  if (!profile)
    return {
      profile: null,
      state: 'not-applicable',
      reason: 'No hardware-matched timing budget; report observations only',
      checks: []
    }
  const checks = Object.entries(profile.limits).map(([metric, limit]) => {
    const value = metrics[metric] as { p50?: number | null; p95?: number | null } | undefined
    return {
      metric,
      limit,
      observed: value ?? null,
      state:
        !value ||
        value.p50 == null ||
        value.p95 == null ||
        !Number.isFinite(value.p50) ||
        !Number.isFinite(value.p95)
          ? 'unavailable'
          : value.p50 > limit.p50 || value.p95 > limit.p95
            ? 'over-budget'
            : 'within-budget'
    }
  })
  return {
    profile: profile.id,
    state: checks.some((c) => c.state === 'over-budget')
      ? 'over-budget'
      : checks.some((c) => c.state === 'unavailable')
        ? 'incomplete'
        : 'within-budget',
    checks
  }
}
