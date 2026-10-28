export const TASK_PHASES = [
  'queued',
  'admitted',
  'routing',
  'loading',
  'prefill',
  'generating',
  'tool',
  'approval',
  'waiting-child',
  'integrating',
  'done',
  'stopped',
  'failed',
  'incomplete'
] as const
export type TaskPhase = (typeof TASK_PHASES)[number]
export const taskPhaseLabels: Record<TaskPhase, string> = {
  queued: 'Queued',
  admitted: 'Starting',
  routing: 'Understanding request',
  loading: 'Preparing local model',
  prefill: 'Waiting for first model chunk',
  generating: 'Generating',
  tool: 'Using workspace tools',
  approval: 'Waiting for your response',
  'waiting-child': 'Waiting for agents',
  integrating: 'Checking results',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  incomplete: 'Incomplete'
}
export interface TaskPhaseEvent {
  phase: TaskPhase
  at?: number
  reason?: string
  source?: string
  model?: string
  purpose?: string
  queuePosition?: number
  blockedBy?: string | null
  origin?: string
  errorCode?: string
}
export interface TaskTimelineEntry extends TaskPhaseEvent {
  taskId: string
  at: number
  endedAt?: number
}
export interface TaskTimeline {
  version: 1
  current: TaskTimelineEntry
  entries: TaskTimelineEntry[]
  queueWaitMs: number | null
  loadingMs: number
  dispatchToFirstChunkMs: number | null
  firstChunkAt?: number
  lastFailure?: { origin: string; errorCode?: string; at: number }
}
const terminal = new Set<TaskPhase>(['done', 'stopped', 'failed', 'incomplete'])
export function transitionTaskTimeline(
  taskId: string,
  current: TaskTimeline | undefined,
  input: TaskPhaseEvent,
  now = Date.now()
): TaskTimeline {
  const at = Number.isFinite(input.at) ? Math.min(now, Math.max(0, input.at!)) : now
  if (current && terminal.has(current.current.phase)) return current
  // Child/background transports cannot replace the parent's explicit wait state.
  if (
    current &&
    ['approval', 'waiting-child'].includes(current.current.phase) &&
    input.source === 'transport'
  )
    return current
  const row: TaskTimelineEntry = { ...input, taskId, at, reason: input.reason?.slice(0, 500) }
  const previous = current?.current,
    entries = current ? [...current.entries] : []
  let loadingMs = current?.loadingMs ?? 0
  if (previous && previous.phase !== input.phase) {
    entries[entries.length - 1] = { ...previous, endedAt: at }
    if (previous.phase === 'loading') loadingMs += Math.max(0, at - previous.at)
  }
  if (previous?.phase === input.phase)
    entries[entries.length - 1] = { ...previous, ...row, at: previous.at }
  else entries.push(row)
  const queued = entries.find((r) => r.phase === 'queued'),
    admitted = entries.find((r) => r.phase === 'admitted')
  const firstChunkAt =
    current?.firstChunkAt ??
    (input.phase === 'generating' && input.source === 'transport' ? at : undefined)
  const dispatch = previous?.phase === 'prefill' ? previous.at : undefined
  return {
    version: 1,
    current: entries[entries.length - 1],
    entries: entries.slice(-96),
    queueWaitMs:
      current?.queueWaitMs ?? (queued && admitted ? Math.max(0, admitted.at - queued.at) : null),
    loadingMs,
    dispatchToFirstChunkMs:
      current?.dispatchToFirstChunkMs ??
      (input.phase === 'generating' && input.source === 'transport' && dispatch !== undefined
        ? Math.max(0, at - dispatch)
        : null),
    firstChunkAt,
    lastFailure: input.origin
      ? { origin: input.origin, errorCode: input.errorCode, at }
      : current?.lastFailure
  }
}
export function isTaskPhaseEvent(value: unknown): value is TaskPhaseEvent {
  return (
    !!value && typeof value === 'object' && TASK_PHASES.includes((value as TaskPhaseEvent).phase)
  )
}
