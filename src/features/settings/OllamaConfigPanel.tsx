import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, ModelConnection, ModelsStatus } from '@/shared/settings-schema'
import type { OllamaLibraryEntry, OllamaPullProgress } from '@/shared/ollama-types'

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434/v1'
export const OLLAMA_CONNECTION_ID = 'ollama'

function isOllamaConnection(c: ModelConnection): boolean {
  return c.type !== 'builtin' && (c.provider === 'ollama' || c.id === OLLAMA_CONNECTION_ID)
}

/** Mirror of main-process normalize — keep UI paste handling snappy without IPC. */
function normalizeModelRef(input: string): string {
  let s = String(input || '').trim()
  if (!s) return ''
  const fromUrl = s.match(/ollama\.com\/library\/([A-Za-z0-9._:-]+)/i)
  if (fromUrl) {
    s = fromUrl[1]!
  } else {
    const fromCmd = s.match(/^(?:ollama\s+(?:pull|run)\s+)(.+)$/i)
    if (fromCmd) s = fromCmd[1]!.trim()
  }
  s = s.split(/[?#]/)[0] || ''
  s = s.trim().replace(/^\/+|\/+$/g, '')
  s = s.split(/\s+/)[0] || ''
  return s
}

function modelInstalled(name: string, installed: string[]): boolean {
  const n = normalizeModelRef(name)
  if (!n || !installed.length) return false
  if (installed.includes(n)) return true
  if (!n.includes(':')) {
    return installed.some((m) => m === `${n}:latest` || m.startsWith(`${n}:`))
  }
  const [base, tag] = n.split(':')
  if (tag === 'latest') return installed.includes(base!) || installed.includes(n)
  return false
}

interface Props {
  resolved: AppSettings
  status: ModelsStatus | null
  defaultModel: string
  compact?: boolean
  onSaveConnections: (connections: ModelConnection[]) => Promise<void>
  onRefresh: () => Promise<void>
  onSetDefaultModel: (model: string) => Promise<void>
}

/** Browse, pull, and remove local Ollama models from inside Eris. */
function OllamaModelManager({
  reachable,
  defaultModel,
  onChanged,
  onSetDefaultModel
}: {
  reachable: boolean
  defaultModel: string
  onChanged: () => Promise<void> | void
  onSetDefaultModel: (model: string) => Promise<void>
}) {
  const [library, setLibrary] = useState<OllamaLibraryEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [pulling, setPulling] = useState<string | null>(null)
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null)
  const [custom, setCustom] = useState('')
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<string>('all')
  const [err, setErr] = useState<string | null>(null)

  const refreshInstalled = useCallback(async () => {
    const res = await window.ide.ollamaInstalled()
    setInstalled(res.ok ? res.models : [])
  }, [])

  useEffect(() => {
    void window.ide.ollamaLibrary().then(setLibrary).catch(() => undefined)
    void refreshInstalled().catch(() => undefined)
    const off = window.ide.onOllamaPullProgress((p) => setProgress(p))
    return () => off()
  }, [refreshInstalled])

  const families = useMemo(() => {
    const set = new Set(library.map((e) => e.family).filter(Boolean))
    return ['all', ...Array.from(set)]
  }, [library])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return library.filter((e) => {
      if (family !== 'all' && e.family !== family) return false
      if (!q) return true
      return (
        e.name.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.family.toLowerCase().includes(q)
      )
    })
  }, [library, query, family])

  const pull = async (raw: string) => {
    const name = normalizeModelRef(raw)
    if (!name || pulling) return
    setErr(null)
    setPulling(name)
    setProgress({ name, status: 'starting', done: false })
    try {
      const res = await window.ide.ollamaPull(name)
      if (!res.ok) setErr(res.error || 'Pull failed')
      else {
        await refreshInstalled()
        await onChanged()
        if (res.model) {
          // Offer as default when nothing useful is selected yet
          if (!defaultModel || defaultModel.startsWith('builtin:')) {
            await onSetDefaultModel(res.model)
          }
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Pull failed')
    } finally {
      setPulling(null)
      setProgress(null)
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`Delete ${name} from Ollama? This frees disk space.`)) return
    setErr(null)
    try {
      const res = await window.ide.ollamaDelete(name)
      if (!res.ok) setErr(res.error || 'Delete failed')
      else {
        await refreshInstalled()
        await onChanged()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div className="ollama-library">
      <div className="ollama-library-head">
        <div>
          <strong>Pick models to download</strong>
          <span className="model-conn-meta">
            Pull from the catalog or paste any name / ollama.com/library URL. Needs Ollama running
            {reachable ? '' : ' — start it to enable pulls'}.
          </span>
        </div>
        <button
          type="button"
          className="btn"
          title="Browse the full Ollama library in your browser"
          onClick={() => void window.ide.openExternal('https://ollama.com/library')}
        >
          Browse library
        </button>
      </div>

      {installed.length > 0 && (
        <div className="ollama-installed">
          <div className="model-conn-meta">Installed — click to use as default</div>
          <div className="model-chip-row">
            {installed.map((m) => (
              <span key={m} className={`model-chip ${defaultModel === m ? 'active' : ''}`}>
                <button
                  type="button"
                  className="model-chip-label"
                  title="Use as default model"
                  onClick={() => void onSetDefaultModel(m)}
                >
                  {m}
                </button>
                <button
                  type="button"
                  className="model-chip-x"
                  title="Delete from Ollama"
                  onClick={() => void remove(m)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="ollama-custom-pull">
        <input
          value={custom}
          placeholder="Name or URL — e.g. qwen3.8 or https://ollama.com/library/qwen3.8"
          spellCheck={false}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void pull(custom)
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(pulling) || !normalizeModelRef(custom)}
          onClick={() => void pull(custom)}
        >
          {pulling && normalizeModelRef(custom) === pulling ? 'Pulling…' : 'Download'}
        </button>
      </div>

      <div className="ollama-catalog-filters">
        <input
          className="ollama-catalog-search"
          value={query}
          placeholder="Search catalog…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ollama-family-tabs" role="tablist" aria-label="Model family">
          {families.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={family === f}
              className={`ollama-family-tab${family === f ? ' is-active' : ''}`}
              onClick={() => setFamily(f)}
            >
              {f === 'all' ? 'All' : f}
            </button>
          ))}
        </div>
      </div>

      <div className="ollama-catalog">
        {filtered.length === 0 ? (
          <div className="models-empty">
            No catalog matches. Paste a name above or browse the full library.
          </div>
        ) : (
          filtered.map((entry) => {
            const installedAlready = modelInstalled(entry.name, installed)
            const isPulling = pulling === entry.name || pulling === normalizeModelRef(entry.name)
            return (
              <div key={entry.name} className="ollama-catalog-row">
                <div className="ollama-catalog-main">
                  <div className="ollama-catalog-title">
                    <strong>{entry.label}</strong>
                    <code>{entry.name}</code>
                    <span className="badge">{entry.size}</span>
                  </div>
                  <p>{entry.description}</p>
                  {isPulling && progress && (
                    <div className="setup-progress" title={progress.status}>
                      <div style={{ width: `${Math.max(4, progress.percent ?? 6)}%` }} />
                    </div>
                  )}
                  {isPulling && (
                    <div className="model-conn-meta">
                      {progress?.status || 'pulling'}
                      {progress?.percent != null ? ` · ${progress.percent}%` : ''}
                    </div>
                  )}
                </div>
                <div className="ollama-catalog-actions">
                  {installedAlready ? (
                    <>
                      <span className="setup-ready-pill">Installed</span>
                      <button
                        type="button"
                        className="btn"
                        title="Use as default chat model"
                        onClick={() => void onSetDefaultModel(entry.name)}
                      >
                        Use
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={Boolean(pulling)}
                      onClick={() => void pull(entry.name)}
                    >
                      {isPulling ? 'Pulling…' : 'Download'}
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {err && (
        <div className="subtitle" style={{ color: 'var(--danger)', marginTop: 6 }}>
          {err}
        </div>
      )}
    </div>
  )
}

export function OllamaConfigPanel({
  resolved,
  status,
  defaultModel,
  compact = false,
  onSaveConnections,
  onRefresh,
  onSetDefaultModel
}: Props) {
  const ollama = useMemo(
    () => (resolved.models.connections ?? []).find(isOllamaConnection) ?? null,
    [resolved.models.connections]
  )

  const live = useMemo(() => {
    if (!ollama) return null
    return (status?.connections ?? []).find((c) => c.id === ollama.id) ?? null
  }, [status, ollama])

  const [baseUrl, setBaseUrl] = useState(ollama?.baseUrl || OLLAMA_DEFAULT_URL)
  const [urlDirty, setUrlDirty] = useState(false)
  const [showUrl, setShowUrl] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const displayUrl = urlDirty ? baseUrl : ollama?.baseUrl || baseUrl

  const models = useMemo(() => {
    if (live?.models?.length) return live.models
    return ollama?.models ?? []
  }, [live, ollama])

  const reachable = Boolean(live?.reachable)
  const enabled = ollama?.enabled !== false

  const mergeConnections = (nextOllama: ModelConnection): ModelConnection[] => {
    const others = (resolved.models.connections ?? []).filter((c) => !isOllamaConnection(c))
    const builtin = others.filter((c) => c.type === 'builtin')
    const rest = others.filter((c) => c.type !== 'builtin')
    return [...builtin, nextOllama, ...rest]
  }

  const ensureAndRefresh = async (opts?: { enabled?: boolean; baseUrl?: string }) => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const url = (opts?.baseUrl ?? displayUrl).trim().replace(/\/$/, '') || OLLAMA_DEFAULT_URL
      if (!url) {
        setError('Base URL is required')
        return
      }
      const next: ModelConnection = {
        id: ollama?.id || OLLAMA_CONNECTION_ID,
        name: ollama?.name || 'Ollama',
        type: 'openai-compatible',
        provider: 'ollama',
        enabled: opts?.enabled ?? ollama?.enabled ?? true,
        baseUrl: url,
        apiKeyRef: ollama?.apiKeyRef || '',
        models: ollama?.models ?? []
      }
      await onSaveConnections(mergeConnections(next))
      setUrlDirty(false)
      setBaseUrl(url)

      await onRefresh()
      const after = await window.ide.modelsStatus()
      const liveAfter = after.connections.find((c) => c.id === next.id)
      if (liveAfter?.reachable && (liveAfter.models?.length ?? 0) > 0) {
        const withModels = {
          ...next,
          models: liveAfter.models!
        }
        await onSaveConnections(mergeConnections(withModels))
        setInfo(`Connected — ${withModels.models.length} model(s)`)
      } else if (liveAfter && !liveAfter.reachable) {
        setError(liveAfter.error || 'Could not reach Ollama. Is it running? Try: ollama serve')
      } else {
        setInfo('Saved. Download a model below, then refresh if needed.')
      }
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to Ollama')
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async () => {
    if (!ollama) {
      await ensureAndRefresh({ enabled: true })
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSaveConnections(mergeConnections({ ...ollama, enabled: !ollama.enabled }))
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Ollama')
    } finally {
      setBusy(false)
    }
  }

  const removeOllama = async () => {
    if (!ollama) return
    if (!window.confirm('Remove the Ollama connection? Models stay installed in Ollama.')) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const connections = (resolved.models.connections ?? []).filter((c) => !isOllamaConnection(c))
      await onSaveConnections(connections)
      setUrlDirty(false)
      setBaseUrl(OLLAMA_DEFAULT_URL)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove Ollama')
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = !ollama
    ? 'Not connected'
    : !enabled
      ? 'Off'
      : reachable
        ? models.length > 0
          ? `${models.length} model${models.length === 1 ? '' : 's'}`
          : 'Connected · no models'
        : 'Offline'

  const manager = (
    <OllamaModelManager
      reachable={reachable}
      defaultModel={defaultModel}
      onChanged={onRefresh}
      onSetDefaultModel={onSetDefaultModel}
    />
  )

  if (compact) {
    return (
      <div className="ollama-config is-compact">
        <div className="models-row">
          <div className="models-row-main">
            <span className={`status-dot ${reachable && enabled ? 'ok' : ''}`} />
            <div className="models-row-copy">
              <div className="models-row-title">
                <strong>Local Ollama</strong>
              </div>
              <div className="models-row-meta">{statusLabel}</div>
            </div>
          </div>
          <div className="models-row-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void ensureAndRefresh()}
            >
              {busy ? '…' : ollama ? 'Refresh' : 'Connect'}
            </button>
            {ollama && (
              <button type="button" className="btn" disabled={busy} onClick={() => void toggleEnabled()}>
                {enabled ? 'Disable' : 'Enable'}
              </button>
            )}
            <button type="button" className="btn" onClick={() => setShowUrl((v) => !v)}>
              {showUrl ? 'Hide URL' : 'URL'}
            </button>
          </div>
        </div>

        {showUrl && (
          <label className="field ollama-url-field">
            <span>Base URL</span>
            <input
              value={displayUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                setUrlDirty(true)
              }}
              placeholder={OLLAMA_DEFAULT_URL}
              spellCheck={false}
            />
          </label>
        )}

        {(error || (live?.error && !reachable) || info) && (
          <div
            className="models-inline-msg"
            data-tone={error || (live?.error && !reachable) ? 'danger' : 'ok'}
          >
            {error || (!reachable ? live?.error : null) || info}
          </div>
        )}

        {!ollama && !error && !info && (
          <p className="models-hint">
            Install Ollama, Connect, then download models below (e.g. qwen3.8).
          </p>
        )}

        {manager}
      </div>
    )
  }

  return (
    <div className="ollama-config model-connections">
      <div className="model-connections-intro">
        <div className="ollama-config-title">
          <span className={`status-dot ${reachable && enabled ? 'ok' : ''}`} />
          <strong>Ollama</strong>
          <span className="badge">local</span>
          {ollama && !enabled && <span className="badge">off</span>}
          {reachable && enabled && <span className="badge">connected</span>}
        </div>
        <p>
          Run local models through Ollama’s OpenAI-compatible API. Connect, download models from the
          catalog (or paste an ollama.com/library link), then pick one as default — it shows up in
          the chat model menu.
        </p>
      </div>

      <ol className="model-conn-steps">
        <li>
          Install from <code>ollama.com</code> and keep the app (or <code>ollama serve</code>) running.
        </li>
        <li>
          Download a model below — e.g. <code>qwen3.8</code> — or paste a library URL.
        </li>
        <li>
          Click a model chip (or pick it in the chat model menu). Chat uses that model for Ask and
          Agent.
        </li>
      </ol>

      <label className="field ollama-url-field">
        <span>Base URL</span>
        <input
          value={displayUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value)
            setUrlDirty(true)
          }}
          placeholder={OLLAMA_DEFAULT_URL}
          spellCheck={false}
        />
      </label>

      {live?.error && !reachable && (
        <div className="subtitle" style={{ color: 'var(--danger)', marginBottom: 8 }}>
          {live.error}
        </div>
      )}
      {error && (
        <div className="subtitle" style={{ color: 'var(--danger)', marginBottom: 8 }}>
          {error}
        </div>
      )}
      {info && !error && (
        <div className="subtitle" style={{ color: 'var(--success, #3d9a5f)', marginBottom: 8 }}>
          {info}
        </div>
      )}
      {!ollama && !error && !info && (
        <div className="model-conn-meta">Not connected yet — click Connect to add Ollama.</div>
      )}

      {manager}

      <div className="model-conn-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void ensureAndRefresh()}
        >
          {busy ? 'Working…' : ollama ? 'Refresh models' : 'Connect Ollama'}
        </button>
        {ollama && (
          <button type="button" className="btn" disabled={busy} onClick={() => void toggleEnabled()}>
            {enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        {ollama && (
          <button type="button" className="btn" disabled={busy} onClick={() => void removeOllama()}>
            Remove
          </button>
        )}
        {urlDirty && ollama && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setUrlDirty(false)
              setBaseUrl(ollama.baseUrl || OLLAMA_DEFAULT_URL)
            }}
          >
            Reset URL
          </button>
        )}
      </div>
    </div>
  )
}
