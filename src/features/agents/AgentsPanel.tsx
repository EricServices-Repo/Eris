import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BackgroundJob } from '@/shared/background-agents'
import {
  cloudAgentsFallbackReason,
  shouldUseCloudAgents,
  type CloudHealth
} from '@/shared/cloud-agents'
import { deriveBlackboardStatus } from '@/shared/agent-orchestration'
import { formatBackgroundJobDetail } from '@/shared/background-job-detail'

interface Props {
  open: boolean
  workspacePath: string | null
  defaultModel: string
  selectedAgentId?: string | 'auto'
  activeThreadId?: string | null
  onClose: () => void
  onOpenPath?: (path: string) => void
  onBroughtToChat?: (threadId: string) => void
}

function isCloudId(id: string): boolean {
  return id.startsWith('cloud:')
}

export function AgentsPanel({
  open,
  workspacePath,
  defaultModel,
  selectedAgentId = 'auto',
  activeThreadId = null,
  onClose,
  onBroughtToChat
}: Props) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [goal, setGoal] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cloud, setCloud] = useState<CloudHealth | null>(null)

  const refresh = useCallback(async () => {
    const [local, remote, health] = await Promise.all([
      window.ide.listBackgroundJobs(),
      window.ide.listCloudJobs().catch(() => [] as BackgroundJob[]),
      window.ide.cloudAgentsHealth().catch(
        () =>
          ({
            ok: false,
            authenticated: false,
            service: 'eris-cloud-agent',
            version: '',
            llmConfigured: false,
            maxParallel: 0,
            running: 0,
            queued: 0,
            error: 'Unreachable'
          }) satisfies CloudHealth
      )
    ])
    setCloud(health)
    const byId = new Map<string, BackgroundJob>()
    for (const j of [...remote, ...local]) byId.set(j.id, j)
    const list = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    setJobs(list)
    setSelectedId((id) => {
      if (id && list.some((j) => j.id === id)) return id
      return list[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const poll = window.setInterval(() => {
      void refresh()
    }, 4000)
    const unsub = window.ide.onBackgroundJob((evt) => {
      if (evt.type === 'upsert') {
        setJobs((prev) => {
          const next = prev.filter((j) => j.id !== evt.job.id)
          next.unshift(evt.job)
          return next
        })
      } else {
        setJobs((prev) => prev.filter((j) => j.id !== evt.id))
      }
    })
    return () => {
      window.clearInterval(poll)
      unsub()
    }
  }, [open, refresh])

  useEffect(() => {
    if (!selectedId || isCloudId(selectedId)) {
      setDiff('')
      return
    }
    const job = jobs.find((j) => j.id === selectedId)
    if (!job || (job.status !== 'done' && job.status !== 'merged' && job.status !== 'failed')) {
      if (job?.status === 'running' || job?.status === 'queued') setDiff('')
      return
    }
    void window.ide.backgroundJobDiff(selectedId).then((r) => {
      setDiff(r.diff || r.error || '')
    })
  }, [selectedId, jobs])

  const roots = useMemo(() => {
    const byId = new Map(jobs.map((j) => [j.id, j]))
    return jobs.filter((j) => !j.parentId || !byId.has(j.parentId))
  }, [jobs])

  const childrenOf = useCallback(
    (id: string) => jobs.filter((j) => j.parentId === id),
    [jobs]
  )

  const preferCloud = shouldUseCloudAgents(cloud)

  const startLocal = (payload: {
    goal: string
    model: string
    agentId: string | null
    claim: string
  }) =>
    window.ide.enqueueBackgroundJob({
      ...payload,
      mode: 'agent',
      source: 'panel',
      forceRoute: 'tools'
    })

  const probeHealth = async (): Promise<CloudHealth> => {
    try {
      const health = await window.ide.cloudAgentsHealth()
      setCloud(health)
      return health
    } catch (err) {
      const health: CloudHealth = {
        ok: false,
        authenticated: false,
        service: 'eris-cloud-agent',
        version: '',
        llmConfigured: false,
        maxParallel: 0,
        running: 0,
        queued: 0,
        error: err instanceof Error ? err.message : 'Unreachable'
      }
      setCloud(health)
      return health
    }
  }

  const start = () => {
    if (!goal.trim() || !workspacePath) return
    setBusy(true)
    setError(null)
    const payload = {
      goal: goal.trim(),
      model: defaultModel,
      agentId: selectedAgentId === 'auto' ? null : selectedAgentId,
      claim: goal.trim().slice(0, 64)
    }
    void (async () => {
      try {
        // Live health at start — never decide from a stale panel poll alone.
        const health = await probeHealth()
        if (shouldUseCloudAgents(health)) {
          try {
            const job = await window.ide.enqueueCloudJob(payload)
            setGoal('')
            setSelectedId(job.id)
            void refresh()
            return
          } catch (cloudErr) {
            // Only fall back after a real cloud enqueue/network failure.
            const msg = cloudErr instanceof Error ? cloudErr.message : 'Cloud enqueue failed'
            const job = await startLocal(payload)
            setGoal('')
            setSelectedId(job.id)
            setError(`Cloud unavailable (${msg}) — started local agent instead`)
            void refresh()
            return
          }
        }
        const reason = cloudAgentsFallbackReason(health) || 'unreachable'
        const job = await startLocal(payload)
        setGoal('')
        setSelectedId(job.id)
        setError(`Cloud unavailable (${reason}) — started local agent instead`)
        void refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start')
      } finally {
        setBusy(false)
      }
    })()
  }

  if (!open) return null
  const selected = jobs.find((j) => j.id === selectedId) ?? null
  const activeCount = jobs.filter((j) => {
    const b = j.blackboard || deriveBlackboardStatus(j)
    return (
      b === 'running' ||
      b === 'queued' ||
      b === 'planning' ||
      b === 'blocked' ||
      b === 'needs-approval'
    )
  }).length

  return (
    <div className="git-panel">
      <div className="terminal-bar">
        <strong>Agents</strong>
        <span className="thinking-status-inline">
          {activeCount > 0 ? `${activeCount} active` : 'idle'}
        </span>
        <div className="diff-actions">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Editor
          </button>
        </div>
      </div>
      {error && <div className="git-error">{error}</div>}
      <div className="git-commit-row">
        <input
          value={goal}
          placeholder={
            preferCloud
              ? 'Goal for Cloud Agent'
              : 'Goal for local worktree agent (cloud offline)'
          }
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              start()
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !goal.trim() || !workspacePath}
          onClick={start}
        >
          {preferCloud ? 'Start cloud' : 'Start local'}
        </button>
      </div>
      <div className="git-body">
        <div className="git-files">
          <div className="explorer-section-label">Blackboard</div>
          {jobs.length === 0 ? (
            <div className="chat-empty">
              No tasks yet. Cloud status and metrics are in Settings → Agent.
            </div>
          ) : (
            roots.map((j) => (
              <JobTreeButton
                key={j.id}
                job={j}
                depth={0}
                selectedId={selectedId}
                childrenOf={childrenOf}
                onSelect={setSelectedId}
              />
            ))
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          {selected && (
            <div className="debug-toolbar">
              <button
                type="button"
                className="btn"
                disabled={selected.status !== 'running' && selected.status !== 'queued'}
                onClick={() =>
                  void (isCloudId(selected.id)
                    ? window.ide.stopCloudJob(selected.id)
                    : window.ide.stopBackgroundJob(selected.id)
                  ).then(() => refresh())
                }
              >
                Stop
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={selected.status !== 'done' || isCloudId(selected.id)}
                title={isCloudId(selected.id) ? 'Cloud jobs hand off via answer/files — merge is local-only' : undefined}
                onClick={() =>
                  void window.ide
                    .mergeBackgroundJob(selected.id)
                    .then(() => refresh())
                    .catch((err) => setError(err instanceof Error ? err.message : 'Merge failed'))
                }
              >
                Merge
              </button>
              <button
                type="button"
                className="btn"
                disabled={
                  selected.status !== 'done' &&
                  selected.status !== 'failed' &&
                  selected.status !== 'stopped' &&
                  selected.status !== 'merged'
                }
                onClick={() =>
                  void window.ide
                    .bringJobIntoChat(selected.id, activeThreadId)
                    .then((r) => {
                      if (!r.ok) {
                        setError(r.error || 'Bring to chat failed')
                        return
                      }
                      onBroughtToChat?.(r.threadId)
                    })
                    .catch((err) =>
                      setError(err instanceof Error ? err.message : 'Bring to chat failed')
                    )
                }
              >
                Bring to chat
              </button>
              <button
                type="button"
                className="btn"
                disabled={selected.status === 'merged' || isCloudId(selected.id)}
                onClick={() =>
                  void window.ide
                    .discardBackgroundJob(selected.id)
                    .then(() => refresh())
                    .catch((err) => setError(err instanceof Error ? err.message : 'Discard failed'))
                }
              >
                Discard
              </button>
            </div>
          )}
          <pre className="git-diff agents-live">
            {selected ? formatBackgroundJobDetail(selected, diff) : helpText(preferCloud)}
          </pre>
        </div>
      </div>
      <div className="debug-hint">
        Cloud Agents require EricServic.es sign-in (Settings → Account). Local agents are used when
        signed out, offline, or enqueue fails — not while the remote model is still downloading.
      </div>
    </div>
  )
}

function JobTreeButton({
  job,
  depth,
  selectedId,
  childrenOf,
  onSelect
}: {
  job: BackgroundJob
  depth: number
  selectedId: string | null
  childrenOf: (id: string) => BackgroundJob[]
  onSelect: (id: string) => void
}) {
  const board = job.blackboard || deriveBlackboardStatus(job)
  const kids = childrenOf(job.id)
  const cloud = isCloudId(job.id)
  return (
    <>
      <button
        type="button"
        className={`git-file${job.id === selectedId ? ' is-active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onSelect(job.id)}
      >
        <span className="diff-op">{board}</span>
        <span>
          {(job.claim || job.goal).slice(0, 64)}
          <div className="hint">
            {(job.agentName || job.agentId) +
              (cloud ? ' · cloud' : job.source === 'delegate' ? ' · delegate' : '') +
              (kids.length ? ` · ${kids.length} child` : '')}
          </div>
        </span>
      </button>
      {kids.map((c) => (
        <JobTreeButton
          key={c.id}
          job={c}
          depth={depth + 1}
          selectedId={selectedId}
          childrenOf={childrenOf}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function helpText(preferCloud: boolean): string {
  return [
    'Blackboard: local worktree agents + Cloud Agents.',
    'Cloud status and metrics: Settings → Agent. Sign-in: Settings → Account.',
    preferCloud
      ? 'Signed in and cloud available — Start uses the remote worker. Local only if health/enqueue fails.'
      : 'Cloud unavailable or signed out — Start uses a local worktree agent.',
    '',
    'Tip: Bring to chat pastes the result into the active thread.'
  ].join('\n')
}
