import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChatAgentActivity } from './ChatAgentActivity'
import { formatBackgroundJobDetail } from '@/shared/background-job-detail'
import type { BackgroundJob } from '@/shared/background-agents'

type Props = {
  onOpenPath?: (path: string) => void
  onOpenChat?: () => void
}

function isCloud(job: BackgroundJob): boolean {
  return job.id.startsWith('cloud:')
}

function statusTone(status: BackgroundJob['status'] | string): string {
  if (status === 'done' || status === 'merged') return 'ok'
  if (status === 'failed' || status === 'stopped' || status === 'discarded') return 'bad'
  if (status === 'running' || status === 'queued') return 'live'
  return ''
}

export function AgentsInboxPanel({ onOpenPath, onOpenChat }: Props) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffPreview, setDiffPreview] = useState<{ id: string; text: string } | null>(null)
  const [goal, setGoal] = useState('')
  const [enqueueing, setEnqueueing] = useState(false)
  const [filter, setFilter] = useState<'all' | 'running' | 'attention'>('all')

  const refresh = useCallback(async () => {
    try {
      const [local, cloud] = await Promise.all([
        window.ide.listBackgroundJobs(),
        window.ide.listCloudJobs().catch(() => [] as BackgroundJob[])
      ])
      const byId = new Map<string, BackgroundJob>()
      for (const j of [...local, ...cloud]) byId.set(j.id, j)
      const list = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      setJobs(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.ide.onBackgroundJob((evt) => {
      if (evt.type === 'removed') {
        setJobs((prev) => prev.filter((j) => j.id !== evt.id))
        return
      }
      setJobs((prev) => {
        const next = prev.filter((j) => j.id !== evt.job.id)
        next.unshift(evt.job)
        return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
    })
    const timer = setInterval(() => void refresh(), 12_000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [refresh])

  const active = useMemo(
    () =>
      jobs
        .filter((j) => !['discarded', 'merged'].includes(j.status))
        .filter(
          (j) =>
            filter === 'all' ||
            (filter === 'running'
              ? ['running', 'queued'].includes(j.status)
              : ['done', 'failed', 'stopped'].includes(j.status))
        ),
    [jobs, filter]
  )

  const runAction = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  const enqueueLocal = async () => {
    const text = goal.trim()
    if (!text || enqueueing) return
    setEnqueueing(true)
    setError(null)
    try {
      await window.ide.enqueueBackgroundJob({
        goal: text,
        model: '',
        mode: 'agent',
        source: 'panel'
      })
      setGoal('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enqueue')
    } finally {
      setEnqueueing(false)
    }
  }

  return (
    <div className="agents-inbox">
      <header className="agents-inbox-header">
        <div>
          <h2>Agents</h2>
          <p>Follow the active chat, specialist handoffs, and background work.</p>
        </div>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      <ChatAgentActivity />
      <div className="agent-section-heading">
        <h3>Background work</h3>
        <select
          aria-label="Filter background agents"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="all">All tasks</option>
          <option value="running">In progress</option>
          <option value="attention">Needs review</option>
        </select>
      </div>
      <div className="agents-inbox-compose">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe a separate task, its scope, and what a good result looks like…"
          rows={2}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!goal.trim() || enqueueing}
          onClick={() => void enqueueLocal()}
        >
          {enqueueing ? 'Starting…' : 'Run in background'}
        </button>
      </div>

      {error && <div className="agents-inbox-error">{error}</div>}

      {active.length === 0 ? (
        <div className="agents-inbox-empty">
          No active jobs. Delegate from chat or enqueue a task above. Cloud Composer still runs
          inline in Agent mode when signed in.
        </div>
      ) : (
        <ul className="agents-inbox-list">
          {active.map((job) => {
            const cloud = isCloud(job)
            const busy = busyId === job.id
            return (
              <li key={job.id} className={`agents-inbox-card tone-${statusTone(job.status)}`}>
                <div className="agents-inbox-card-top">
                  <span className={`agents-inbox-badge ${cloud ? 'cloud' : 'local'}`}>
                    {cloud ? 'Cloud' : 'Local'}
                  </span>
                  <span className="agents-inbox-status">{job.blackboard || job.status}</span>
                  <span className="agents-inbox-meta">
                    {job.agentName || job.agentId} · step {job.step}
                  </span>
                </div>
                <div className="agents-inbox-goal" title={job.goal}>
                  {job.goal}
                </div>
                {job.handoff && (
                  <div className="agent-handoff-label">
                    {job.handoff.fromAgentId} → {job.handoff.toAgentId}
                  </div>
                )}
                {job.routeReason && <p className="agents-inbox-live">{job.routeReason}</p>}
                {job.liveStatus && <div className="agents-inbox-live">{job.liveStatus}</div>}
                {job.error && <div className="agents-inbox-error">{job.error}</div>}
                {job.prUrl && (
                  <a className="agents-inbox-pr" href={job.prUrl} target="_blank" rel="noreferrer">
                    Open pull request
                  </a>
                )}
                <details className="agent-evidence">
                  <summary>Assignment, handoff & evidence</summary>
                  <pre>{formatBackgroundJobDetail(job, '')}</pre>
                </details>
                <div className="agents-inbox-actions">
                  {!cloud && ['done', 'stopped', 'failed'].includes(job.status) && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void runAction(job.id, () => window.ide.mergeBackgroundJob(job.id))
                      }
                    >
                      Merge
                    </button>
                  )}
                  {cloud && job.hasArtifacts && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void runAction(job.id, () => window.ide.applyCloudJobArtifacts(job.id))
                      }
                    >
                      Apply patches
                    </button>
                  )}
                  {!cloud && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void runAction(job.id, async () => {
                          const diff = await window.ide.backgroundJobDiff(job.id)
                          setDiffPreview({
                            id: job.id,
                            text: diff.ok ? diff.diff : diff.error || 'No diff'
                          })
                        })
                      }
                    >
                      Diff
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void runAction(job.id, async () => {
                        await window.ide.bringJobIntoChat(job.id)
                        onOpenChat?.()
                      })
                    }
                  >
                    Open in chat
                  </button>
                  {['running', 'queued'].includes(job.status) && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void runAction(job.id, () =>
                          cloud
                            ? window.ide.stopCloudJob(job.id.replace(/^cloud:/, ''))
                            : window.ide.stopBackgroundJob(job.id)
                        )
                      }
                    >
                      Stop
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void runAction(job.id, () => window.ide.discardBackgroundJob(job.id))
                    }
                  >
                    Dismiss
                  </button>
                  {job.filesTouched?.[0] && onOpenPath && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onOpenPath(job.filesTouched[0]!)}
                    >
                      Open file
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {diffPreview && (
        <div className="agents-inbox-diff">
          <div className="agents-inbox-diff-bar">
            <strong>Diff · {diffPreview.id.slice(0, 8)}</strong>
            <button type="button" className="btn" onClick={() => setDiffPreview(null)}>
              Close
            </button>
          </div>
          <pre>{diffPreview.text.slice(0, 20_000)}</pre>
        </div>
      )}
    </div>
  )
}
