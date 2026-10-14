import { useCallback, useEffect, useState } from 'react'
import { joinWorkspacePath } from '@/shared/paths'

interface Props {
  workspacePath: string | null
  onOpenPath?: (path: string, line?: number) => void
  onOpenSettings?: (category: 'rules' | 'skills' | 'context') => void
}

type Stats = Awaited<ReturnType<typeof window.ide.codeIndexStats>>

export function CodemapPanel({ workspacePath, onOpenPath, onOpenSettings }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setStats(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      setStats(await window.ide.codeIndexStats())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load index')
    } finally {
      setBusy(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const rebuild = async () => {
    if (!workspacePath) return
    setBusy(true)
    setError(null)
    try {
      await window.ide.rebuildCodeIndex()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rebuild failed')
      setBusy(false)
    }
  }

  if (!workspacePath) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span>Codemap</span>
        </div>
        <div className="panel-body">
          <p className="hint">Open a workspace to index files and symbols.</p>
        </div>
      </div>
    )
  }

  const q = filter.trim().toLowerCase()
  const symbols = (stats?.topSymbols || []).filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q)
  )

  return (
    <div className="panel codemap-panel">
      <div className="panel-header">
        <span>Codemap</span>
        <div className="panel-header-actions">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void rebuild()}>
            {busy ? 'Indexing…' : 'Rebuild'}
          </button>
        </div>
      </div>
      <div className="panel-body codemap-body">
        {error && <div className="git-error">{error}</div>}
        <div className="codemap-stats">
          <div className="codemap-stat">
            <strong>{stats?.files ?? '—'}</strong>
            <span>files</span>
          </div>
          <div className="codemap-stat">
            <strong>{stats?.symbols ?? '—'}</strong>
            <span>symbols</span>
          </div>
          <div className="codemap-stat">
            <strong>{stats?.refs ?? '—'}</strong>
            <span>refs</span>
          </div>
          <div className="codemap-stat">
            <strong>{stats?.rules ?? '—'}</strong>
            <span>rules</span>
          </div>
          <div className="codemap-stat">
            <strong>{stats?.skills ?? '—'}</strong>
            <span>skills</span>
          </div>
        </div>
        <p className="hint codemap-summary">
          {stats?.summary || 'Semantic index used by agent search and routing.'}
        </p>
        <div className="codemap-links">
          <button type="button" className="btn" onClick={() => onOpenSettings?.('context')}>
            Context
          </button>
          <button type="button" className="btn" onClick={() => onOpenSettings?.('rules')}>
            Rules
          </button>
          <button type="button" className="btn" onClick={() => onOpenSettings?.('skills')}>
            Skills
          </button>
        </div>
        <input
          className="codemap-filter"
          placeholder="Filter symbols…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="codemap-symbol-list">
          {symbols.map((s) => (
            <li key={`${s.path}:${s.line}:${s.name}`}>
              <button
                type="button"
                onClick={() => {
                  const abs = workspacePath
                    ? joinWorkspacePath(workspacePath, s.path)
                    : s.path
                  onOpenPath?.(abs, s.line)
                }}
              >
                <strong>{s.name}</strong>
                <span>
                  {s.kind} · {s.path}:{s.line}
                </span>
              </button>
            </li>
          ))}
          {symbols.length === 0 && (
            <li className="hint">{busy ? 'Loading…' : 'No symbols yet — Rebuild the index.'}</li>
          )}
        </ul>
      </div>
    </div>
  )
}
