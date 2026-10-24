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
    recordChatJobEvent(requestId, channel, data)
    if (['chat:task', 'chat:evidence', 'chat:outcome'].includes(channel))
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
  target.send('chat:job-snapshot', { requestId: job.id, job })
  if (job.status === 'failed')
    target.send('chat:error', {
      requestId: job.id,
      error: job.persistenceError ?? 'Previous task failed'
    })
  else if (!['queued', 'running'].includes(job.status))
    target.send('chat:done', {
      requestId: job.id,
      aborted: job.status === 'stopped',
      incomplete: job.status === 'incomplete'
    })
}
