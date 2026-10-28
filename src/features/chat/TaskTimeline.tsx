import { useEffect, useState } from 'react'
import type { ChatJobSnapshot } from '@/shared/chat-jobs'
import { taskPhaseLabels } from '@/shared/task-timeline'
const duration = (ms: number | null) => (ms === null ? 'Unavailable' : `${(ms / 1000).toFixed(1)}s`)
export function TaskTimelineView({ job }: { job: ChatJobSnapshot }) {
  const [error, setError] = useState(''),
    timeline = job.timeline,
    active = ['running', 'queued'].includes(job.status)
  if (!timeline)
    return (
      <p>
        Task {job.id.slice(0, 8)} · {job.status} · Detailed timing unavailable for this older
        record.
      </p>
    )
  return (
    <section className="task-timeline" aria-label="Task execution timeline">
      <p role="status">
        {taskPhaseLabels[timeline.current.phase]} · Task {job.id.slice(0, 8)}
        {timeline.current.queuePosition ? ` · Queue #${timeline.current.queuePosition}` : ''}
      </p>
      {timeline.current.reason && <p>{timeline.current.reason}</p>}
      {active && Date.now() - Date.parse(job.updatedAt) > 30000 && (
        <p>
          No new task output for 30 seconds. Current wait:{' '}
          {timeline.current.reason ?? taskPhaseLabels[timeline.current.phase]}.
        </p>
      )}
      {active && (
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.ide
              .stopChat(job.id)
              .then((stopped) => {
                if (!stopped)
                  setError('This task has already finished or is no longer owned by this window.')
              })
              .catch(() => setError('Could not stop this task.'))
          }
        >
          Stop task {job.id.slice(0, 8)}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Timing and evidence</summary>
        <p>
          Queue: {duration(timeline.queueWaitMs)} · Model preparation:{' '}
          {duration(timeline.loadingMs)} · Dispatch to first model chunk:{' '}
          {duration(timeline.dispatchToFirstChunkMs)}
        </p>
        <p>
          Dispatch timing includes transport/prefill. It excludes the foreground queue and measured
          model preparation; this is not token-to-paint latency.
        </p>
        <ol>
          {timeline.entries.map((row, index) => (
            <li key={index}>
              {taskPhaseLabels[row.phase]} · {row.source ?? 'runtime'}
              {row.model ? ` · ${row.model}` : ''}
              {row.endedAt ? ` · ${duration(Math.max(0, row.endedAt - row.at))}` : ''}
              {row.reason ? ` · ${row.reason}` : ''}
            </li>
          ))}
        </ol>
        {timeline.lastFailure && (
          <p>
            Last failure origin: {timeline.lastFailure.origin} ·{' '}
            {timeline.lastFailure.errorCode ?? 'No code reported'}
          </p>
        )}
      </details>
    </section>
  )
}
export function ChatTaskTimeline({ threadId }: { threadId: string | null }) {
  const [job, setJob] = useState<ChatJobSnapshot | null>(null)
  useEffect(() => {
    let disposed = false
    setJob(null)
    const refresh = () =>
      void window.ide
        .getLatestChatJob(threadId)
        .then((value) => {
          if (!disposed) setJob(value)
        })
        .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 1500)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [threadId])
  return job ? <TaskTimelineView job={job} /> : null
}
