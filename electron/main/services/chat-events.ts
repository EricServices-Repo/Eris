import type { ChatJobSnapshot } from '../../../src/shared/chat-jobs'
import { finishChatJob, recordChatJobEvent } from './chat-job-controller'
import { appendTaskEvent, flushTaskLedger } from './task-ledger'
export interface ChatEventTarget {
  isDestroyed(): boolean
  send(channel: string, data: Record<string, unknown>): void
}
/** One owner for foreground event persistence, publication and terminal transitions. */
export function chatPublisher(requestId: string, target: () => ChatEventTarget) {
  return (channel: string, data: Record<string, unknown>): void => {
    // After the task ended, a second outcome or straggling chunk is recorded as late and
    // goes no further: the renderer must not show an error for a task that completed.
    if (!recordChatJobEvent(requestId, channel, data)) return
    if (['chat:task', 'chat:evidence', 'chat:outcome', 'chat:phase'].includes(channel))
      appendTaskEvent(requestId, channel, data)
    const sender = target()
    if (!sender.isDestroyed()) sender.send(channel, data)
    if (channel === 'chat:done')
      finishChatJob(requestId, data.aborted ? 'stopped' : data.incomplete ? 'incomplete' : 'done')
    else if (channel === 'chat:error') {
      finishChatJob(requestId, 'failed')
      void flushTaskLedger(requestId)
    }
  }
}
/** Reattachment replays observations; approval requests and effects are never re-executed. */
export function replayChatJob(job: ChatJobSnapshot, target: ChatEventTarget): void {
  if (target.isDestroyed()) return
  if (job.answer)
    target.send('chat:answer', { requestId: job.id, chunk: job.answer, replace: true })
  for (const item of job.events)
    if (
      [
        'chat:task',
        'chat:tool',
        'chat:diff',
        'chat:checkpoint',
        'chat:model',
        'chat:routed',
        'chat:evidence',
        'chat:outcome'
      ].includes(item.channel)
    )
      target.send(item.channel, item.payload)
  if (job.timeline) target.send('chat:phase', { requestId: job.id, ...job.timeline.current })
  target.send('chat:job-snapshot', { requestId: job.id, job })
  // Reattach to the host-owned result; never reconstruct or append a reply in UI.
  const terminal = [...job.events].reverse().find(item =>
    ['chat:done','chat:error'].includes(item.channel) && item.payload.reply)
  const reply = terminal?.payload.reply
  if (job.status === 'failed')
    target.send('chat:error', {
      requestId: job.id,
      error: job.persistenceError ?? 'Previous task failed',
      reply
    })
  else if (!['queued', 'running'].includes(job.status))
    target.send('chat:done', {
      requestId: job.id,
      aborted: job.status === 'stopped',
      incomplete: job.status === 'incomplete',
      reply
    })
}
