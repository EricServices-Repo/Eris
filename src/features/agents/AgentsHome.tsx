import { useCallback, useEffect, useState } from 'react'
import type { BackgroundJob } from '@/shared/background-agents'
import { deriveBlackboardStatus } from '@/shared/agent-orchestration'

interface Props {
  workspacePath: string | null
  onOpenAgentsPanel: () => void
  onSelectJob?: (id: string) => void
}

function shortId(id: string): string {
  return id.replace(/^cloud:/, '').slice(0, 8)
}

function statusDot(status: string): string {
  if (status === 'running' || status === 'queued') return 'warn'
  if (status === 'done' || status === 'merged') return 'ok'
  if (status === 'failed' || status === 'stopped') return 'danger'
  return ''
}

export function AgentsHome({ workspacePath, onOpenAgentsPanel, onSelectJob }: Props) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [open, setOpen] = useState(true)

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setJobs([])
      return
    }
    const [local, remote] = await Promise.all([
      window.ide.listBackgroundJobs().catch(() => [] as BackgroundJob[]),
      window.ide.listCloudJobs().catch(() => [] as BackgroundJob[])
    ])
    const byId = new Map<string, BackgroundJob>()
    for (const j of [...remote, ...local]) byId.set(j.id, j)
    setJobs([...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12))
  }, [workspacePath])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 5000)
    const unsub = window.ide.onBackgroundJob(() => void refresh())
    return () => {
      window.clearInterval(id)
      unsub()
    }
  }, [refresh])

  if (!workspacePath) return null

  return (
    <div className="project-menu-group agents-home">
      <div className="project-menu-row">
        <button type="button" className="project-menu-label" onClick={() => setOpen((v) => !v)}>
          <span className="project-menu-twistie">{open ? '▾' : '▸'}</span>
          <span>Agents</span>
          <span className="badge">{jobs.length}</span>
        </button>
        <button
          type="button"
          className="btn-ghost project-menu-add"
          title="Open Agents panel"
          onClick={onOpenAgentsPanel}
        >
          ↗
        </button>
      </div>
      {open && (
        <div className="project-menu-items">
          {jobs.length === 0 ? (
            <button type="button" className="project-menu-item muted" onClick={onOpenAgentsPanel}>
              No jobs — open Agents
            </button>
          ) : (
            jobs.map((j) => {
              const board = deriveBlackboardStatus(j)
              return (
                <button
                  key={j.id}
                  type="button"
                  className="project-menu-item agents-home-item"
                  title={j.goal}
                  onClick={() => {
                    onSelectJob?.(j.id)
                    onOpenAgentsPanel()
                  }}
                >
                  <span className={`status-dot ${statusDot(j.status)}`} />
                  <span className="agents-home-copy">
                    <strong>{shortId(j.id)}</strong>
                    <em>
                      {board} · {(j.claim || j.goal || '').slice(0, 42)}
                    </em>
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
