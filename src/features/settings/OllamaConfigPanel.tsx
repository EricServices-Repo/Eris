import { useMemo, useState } from 'react'
import type { AppSettings, ModelConnection, ModelsStatus } from '@/shared/settings-schema'

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434/v1'
export const OLLAMA_CONNECTION_ID = 'ollama'

function isOllamaConnection(c: ModelConnection): boolean {
  return c.type !== 'builtin' && (c.provider === 'ollama' || c.id === OLLAMA_CONNECTION_ID)
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
        setInfo('Saved. Pull a model with ollama pull, then refresh again.')
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

        {models.length > 0 && (
          <div className="model-chip-row">
            {models.map((m) => (
              <button
                key={m}
                type="button"
                className={`model-chip ${defaultModel === m ? 'active' : ''}`}
                title="Use as default model"
                onClick={() => void onSetDefaultModel(m)}
              >
                {m}
              </button>
            ))}
          </div>
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
            Install Ollama, run <code>ollama pull …</code>, then Connect.
          </p>
        )}
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
          Run local models through Ollama’s OpenAI-compatible API. Install Ollama, pull models, then
          connect — they show up in the model picker when reachable.
        </p>
      </div>

      <ol className="model-conn-steps">
        <li>
          Install from <code>ollama.com</code> and keep the app (or <code>ollama serve</code>) running.
        </li>
        <li>
          Pull a model, e.g. <code>ollama pull qwen2.5-coder:7b</code>
        </li>
        <li>
          Connect / Refresh below, click a model chip (or pick it in the chat model menu). Chat uses
          that model for Ask and Agent.
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

      {models.length > 0 && (
        <div className="model-chip-row">
          {models.map((m) => (
            <button
              key={m}
              type="button"
              className={`model-chip ${defaultModel === m ? 'active' : ''}`}
              title="Use as default model"
              onClick={() => void onSetDefaultModel(m)}
            >
              {m}
            </button>
          ))}
        </div>
      )}

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
      {ollama && reachable && models.length === 0 && !error && (
        <div className="model-conn-meta">
          Connected, but no models listed. Run <code>ollama pull …</code> then refresh.
        </div>
      )}

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
