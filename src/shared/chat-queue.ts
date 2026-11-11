/**
 * What the chat's local message queue does when a reply ends (#521).
 *
 * - stopped: the user pressed Stop; the queued messages were typed for the reply
 *   they just stopped, so they wait for an explicit "Send next".
 * - errored: the reply failed; sending the queue at once would run each queued
 *   message against the same broken model, one failure after another.
 * - otherwise the queue drains automatically, oldest first.
 */
export type QueueAction = 'drain' | 'pause-stopped' | 'pause-error' | 'idle'

export function nextQueueAction(input: {
  stopped: boolean
  errored: boolean
  queued: number
}): QueueAction {
  if (input.queued <= 0) return 'idle'
  if (input.stopped) return 'pause-stopped'
  if (input.errored) return 'pause-error'
  return 'drain'
}

/** Why the queue is waiting, shown above the queued messages. */
export type QueuePause = null | 'stopped' | 'error'

export const queuePauseLabel: Record<Exclude<QueuePause, null>, string> = {
  stopped: 'Paused after stop',
  error: 'Paused after an error'
}
