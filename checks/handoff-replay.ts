/** One failure family from the handoff/RAM review, by review ID. */
export const HANDOFF_REPLAY_FAMILIES = ['HR-001', 'HR-002', 'HR-003', 'HR-004', 'HR-005'] as const
export type HandoffReplayFamily = (typeof HANDOFF_REPLAY_FAMILIES)[number]
export type HandoffReplayOutcome = 'completed' | 'blocked' | 'failed' | 'stopped'

/** Every request or child the replay attempted. Facts come from captured provider messages. */
export type HandoffReplayRow = {
  scenario: string
  family: HandoffReplayFamily | 'accounting'
  parentTaskId: string | null
  taskId: string
  contextOrigin: 'parent-recall' | 'queued-handoff' | 'unrelated-request'
  selectedSourceIds: string[]
  /** Planted markers found in what reached the provider adapter, and nowhere else. */
  dispatchedMarkers: string[]
  forbiddenMarkers: string[]
  requiredMarkers: string[]
  outcome: HandoffReplayOutcome
  expectedOutcome: HandoffReplayOutcome
  error?: string
  modelCalls: number
  dispatchedChars: number
}

export type HandoffReplayReport = {
  version: 1
  /** Scripted by construction. A live result must use a different label. */
  evidence: 'deterministic-scripted'
  rows: HandoffReplayRow[]
  resources: { reservedBytesAfter: number; persistedDiagnosticJobs: number }
}

/** Runs against the captured report, so a green result can only come from real dispatches. */
export function evaluateHandoffReplay(report: HandoffReplayReport | undefined) {
  if (!report) return ['Missing handoff replay report']
  const failures: string[] = []
  if (report.evidence !== 'deterministic-scripted')
    failures.push(`Unexpected evidence label ${String(report.evidence)}`)
  for (const family of HANDOFF_REPLAY_FAMILIES)
    if (!report.rows.some((row) => row.family === family))
      failures.push(`Replay has no scenario for ${family}`)
  for (const row of report.rows) {
    const label = `${row.family} ${row.scenario}`
    if (row.outcome !== row.expectedOutcome)
      failures.push(`${label}: ended ${row.outcome}, expected ${row.expectedOutcome}`)
    for (const marker of row.requiredMarkers)
      if (!row.dispatchedMarkers.includes(marker))
        failures.push(`${label}: ${marker} never reached the provider`)
    for (const marker of row.forbiddenMarkers)
      if (row.dispatchedMarkers.includes(marker))
        failures.push(`${label}: ${marker} reached the provider`)
    if (row.outcome === 'completed' && !row.modelCalls)
      failures.push(`${label}: completed with no model call`)
    if (row.outcome === 'blocked' && row.modelCalls)
      failures.push(`${label}: blocked but still called a model`)
  }
  if (report.resources.reservedBytesAfter)
    failures.push(`${report.resources.reservedBytesAfter} bytes still reserved after the replay`)
  if (report.resources.persistedDiagnosticJobs)
    failures.push(`Diagnostics created ${report.resources.persistedDiagnosticJobs} real jobs`)
  return failures
}
