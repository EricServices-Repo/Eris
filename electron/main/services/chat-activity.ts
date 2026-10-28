import { AsyncLocalStorage } from 'async_hooks'
import type { TaskPhaseEvent } from '../../../src/shared/task-timeline'
const activity = new AsyncLocalStorage<{ taskId: string; emit: (event: TaskPhaseEvent) => void }>()
export const runWithChatActivity = <T>(
  taskId: string,
  emit: (event: TaskPhaseEvent) => void,
  work: () => T
) => activity.run({ taskId, emit }, work)
export function reportChatActivity(
  phase: TaskPhaseEvent['phase'],
  metadata: Omit<TaskPhaseEvent, 'phase'> = {}
) {
  activity.getStore()?.emit({ phase, at: Date.now(), ...metadata })
}

export function reportChatActivityFor(
  taskId: string,
  phase: TaskPhaseEvent['phase'],
  metadata: Omit<TaskPhaseEvent, 'phase'> = {}
) {
  if (activity.getStore()?.taskId === taskId) reportChatActivity(phase, metadata)
}
