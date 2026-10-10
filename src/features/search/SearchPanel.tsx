import { useCallback, useEffect, useState } from 'react'

type Mode = 'grep' | 'files' | 'symbols'

interface Props {
  open: boolean
  workspacePath: string | null
  onClose: () => void
  onOpenPath: (path: string, line?: number) => void
}

export function SearchPanel({ open, workspacePath, onClose, onOpenPath }: Props) {
  const [mode, setMode] = useState<Mode>('grep')
  const [query, setQuery] = useState('')
  const [glob, setGlob] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [grepHits, setGrepHits] = useState<
    Array<{ path: string; line: number; text: string }>
  >([])
  const [paths, setPaths] = useState<string[]>([])
  const [symbols, setSymbols] = useState<
    Array<{ name: string; kind: string; path: string; line: number }>
  >([])

  const run = useCallback(async () => {
    if (!workspacePath || !query.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'grep') {
        const r = await window.ide.searchGrep(query.trim(), glob.trim() || undefined)
        if (!r.ok) setError(r.detail)
        setGrepHits(r.hits || [])
        setPaths([])
        setSymbols([])
      } else if (mode === 'files') {
        const r = await window.ide.searchGlob(query.trim())
        setPaths(r.paths || [])
        setGrepHits([])
        setSymbols([])
      } else {
        const r = await window.ide.searchSymbols(query.trim())
        setSymbols(r.hits || [])
        setGrepHits([])
        setPaths([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setBusy(false)
    }
  }, [workspacePath, query, glob, mode])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="search-panel">
      <div className="terminal-bar">
        <strong>Search</strong>
        <div className="diff-actions">
          <button
            type="button"
            className={`btn ${mode === 'grep' ? 'btn-primary' : ''}`}
            onClick={() => setMode('grep')}
          >
            Text
          </button>
          <button
            type="button"
            className={`btn ${mode === 'files' ? 'btn-primary' : ''}`}
            onClick={() => setMode('files')}
          >
            Files
          </button>
          <button
            type="button"
            className={`btn ${mode === 'symbols' ? 'btn-primary' : ''}`}
            onClick={() => setMode('symbols')}
          >
            Symbols
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            mode === 'grep'
              ? 'Search text / regex'
              : mode === 'files'
                ? '**/*.tsx'
                : 'Symbol name'
          }
        />
        {mode === 'grep' && (
          <input
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
            placeholder="glob (optional) e.g. *.ts"
            style={{ maxWidth: 160 }}
          />
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !query.trim()}>
          {busy ? '…' : 'Search'}
        </button>
      </form>
      {error && <div className="git-error">{error}</div>}
      <div className="search-results">
        {mode === 'grep' &&
          grepHits.map((h, i) => (
            <button
              key={`${h.path}:${h.line}:${i}`}
              type="button"
              className="search-hit"
              onClick={() => onOpenPath(h.path, h.line)}
            >
              <span className="search-hit-path">
                {h.path}:{h.line}
              </span>
              <span className="search-hit-text">{h.text}</span>
            </button>
          ))}
        {mode === 'files' &&
          paths.map((p) => (
            <button
              key={p}
              type="button"
              className="search-hit"
              onClick={() => onOpenPath(p)}
            >
              <span className="search-hit-path">{p}</span>
            </button>
          ))}
        {mode === 'symbols' &&
          symbols.map((s, i) => (
            <button
              key={`${s.path}:${s.line}:${i}`}
              type="button"
              className="search-hit"
              onClick={() => onOpenPath(s.path, s.line)}
            >
              <span className="diff-op">{s.kind}</span>
              <span className="search-hit-path">
                {s.name} — {s.path}:{s.line}
              </span>
            </button>
          ))}
        {!busy &&
          !error &&
          grepHits.length === 0 &&
          paths.length === 0 &&
          symbols.length === 0 && (
            <div className="chat-empty">Enter a query and search the workspace.</div>
          )}
      </div>
    </div>
  )
}
