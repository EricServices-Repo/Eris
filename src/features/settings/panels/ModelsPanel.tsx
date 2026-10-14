import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, BuiltinModelStatus, ModelsStatus } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { ModelConnectionsPanel } from '../ModelConnectionsPanel'
import { OllamaConfigPanel } from '../OllamaConfigPanel'

export function useModelsPanelState() {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  return { downloadingId, setDownloadingId, verifyingId, setVerifyingId }
}

export type ModelsPanelState = ReturnType<typeof useModelsPanelState>

function sizeLabel(bytes: number): string {
  return bytes >= 1e9
    ? `~${(bytes / 1e9).toFixed(1)} GB`
    : `~${Math.round(bytes / 1e6)} MB`
}

function BuiltinRow({
  b,
  isDefault,
  downloadingId,
  verifyingId,
  setDownloadingId,
  setVerifyingId,
  apply,
  load,
  currentDefault
}: {
  b: BuiltinModelStatus
  isDefault: boolean
  downloadingId: string | null
  verifyingId: string | null
  setDownloadingId: (id: string | null) => void
  setVerifyingId: (id: string | null) => void
  apply: ApplySetting
  load: () => Promise<void>
  currentDefault?: string
}) {
  const isDownloading = downloadingId === b.id || Boolean(b.downloading)
  const size = sizeLabel(b.approxBytes)
  const pct = Math.round((b.progress || 0) * 100)
  const statusText = b.ready
    ? 'Ready'
    : isDownloading
      ? pct > 0
        ? `Downloading · ${pct}%`
        : 'Downloading…'
      : b.installed
        ? 'Needs re-download'
        : `Not installed · ${size}`

  const startDownload = () => {
    setDownloadingId(b.id)
    void window.ide
      .downloadBuiltinModel(b.id)
      .then(async () => {
        await load()
        const shouldPromote =
          b.tier === 'lite' &&
          (!currentDefault?.startsWith('builtin:') ||
            currentDefault === b.ref ||
            currentDefault === 'builtin:composer')
        if (shouldPromote) await apply(['models', 'defaultModel'], b.ref)
      })
      .catch(async (err: unknown) => {
        await load()
        const msg = err instanceof Error ? err.message : 'Download failed'
        window.alert(
          `${msg}\n\nTip: Retry, check VPN/firewall, or open the Hugging Face URL in a browser.`
        )
      })
      .finally(() => setDownloadingId(null))
  }

  return (
    <div className={`models-row${isDefault ? ' is-default' : ''}${b.ready ? ' is-ready' : ''}`}>
      <div className="models-row-main">
        <span
          className={`status-dot ${b.ready ? 'ok' : isDownloading ? 'warn' : b.downloadError ? 'danger' : ''}`}
        />
        <div className="models-row-copy">
          <div className="models-row-title">
            <strong>{b.displayName}</strong>
            {b.tier === 'lite' && <span className="models-tag">Chat</span>}
            {b.tier === 'full' && <span className="models-tag">Worker</span>}
            {isDefault && <span className="models-tag is-accent">Default</span>}
          </div>
          <div className="models-row-meta">{statusText}</div>
          {(isDownloading || (!b.ready && b.progress > 0 && b.progress < 1)) && (
            <div className="models-progress">
              <div style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          )}
          {b.downloadError && !isDownloading && !b.ready && (
            <p className="models-download-error" title={b.downloadError}>
              {b.downloadError}
            </p>
          )}
        </div>
      </div>
      <div className="models-row-actions">
        {b.ready ? (
          <>
            {b.tier === 'lite' && !isDefault && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void apply(['models', 'defaultModel'], b.ref)}
              >
                Use
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={verifyingId === b.id}
              onClick={() => {
                setVerifyingId(b.id)
                void window.ide
                  .verifyBuiltinModel(b.id)
                  .then((result) => {
                    if (!result.ok) window.alert(result.error || 'Verification failed')
                    return load()
                  })
                  .catch((err: unknown) => {
                    window.alert(err instanceof Error ? err.message : 'Verification failed')
                  })
                  .finally(() => setVerifyingId(null))
              }}
            >
              {verifyingId === b.id ? '…' : 'Verify'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (window.confirm(`Delete ${b.displayName}? You can download it again later.`)) {
                  void window.ide.deleteBuiltinModel(b.id).then(() => load())
                }
              }}
            >
              Delete
            </button>
          </>
        ) : isDownloading ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              void window.ide.cancelBuiltinDownload()
              setDownloadingId(null)
              void load()
            }}
          >
            Cancel
          </button>
        ) : downloadingId && downloadingId !== b.id ? (
          <button type="button" className="btn" disabled>
            Waiting
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={startDownload}>
              {b.downloadError ? 'Retry' : 'Download'}
            </button>
            {b.downloadUrl ? (
              <button
                type="button"
                className="btn"
                title="Open the Hugging Face download URL in your browser"
                onClick={() => void window.ide.openExternal(b.downloadUrl)}
              >
                Open URL
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export function ModelsPanel({
  state,
  resolved,
  status,
  apply,
  load
}: {
  state: ModelsPanelState
  resolved: AppSettings
  status: ModelsStatus | null
  apply: ApplySetting
  load: () => Promise<void>
}) {
  const { downloadingId, setDownloadingId, verifyingId, setVerifyingId } = state
  const [showApis, setShowApis] = useState(false)

  const builtins = status?.builtin ?? []

  // Restore in-progress download after Settings was closed (main process keeps progress).
  useEffect(() => {
    const active = builtins.find((b) => b.downloading)
    if (active) setDownloadingId(active.id)
  }, [builtins, setDownloadingId])

  const readyOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = []
    for (const b of builtins) {
      if (b.ready && b.tier !== 'full') {
        opts.push({ value: b.ref, label: b.displayName })
      }
    }
    for (const c of status?.connections ?? []) {
      if (!c.reachable || c.type === 'builtin') continue
      for (const name of c.models || []) {
        if (name.startsWith('builtin:')) continue
        opts.push({ value: name, label: `${name} · ${c.name}` })
      }
    }
    // Keep current default visible even if offline
    const def = resolved.models.defaultModel
    if (def && !opts.some((o) => o.value === def)) {
      opts.unshift({ value: def, label: `${def} (offline)` })
    }
    return opts
  }, [builtins, status?.connections, resolved.models.defaultModel])

  return (
    <div className="models-page">
      <section className="models-card">
        <label className="models-default-field">
          <span>Default chat model</span>
          <select
            value={resolved.models.defaultModel || ''}
            onChange={(e) => void apply(['models', 'defaultModel'], e.target.value)}
          >
            {readyOptions.length === 0 && <option value="">No models ready</option>}
            {readyOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="models-hint">Used for Ask / Agent when you don’t pick another model in chat.</p>
      </section>

      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Composer</h3>
            <p>Built into Eris. Lite for chat · Full for multi-file agent work.</p>
          </div>
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
        </header>
        <p className="models-hint" style={{ marginTop: 0 }}>
          Downloads continue if you close Settings. On flaky networks, use Retry or Open URL in a
          browser to confirm Hugging Face is reachable.
        </p>
        <div className="models-row-list">
          {builtins.map((b) => (
            <BuiltinRow
              key={b.id}
              b={b}
              isDefault={resolved.models.defaultModel === b.ref}
              downloadingId={downloadingId}
              verifyingId={verifyingId}
              setDownloadingId={setDownloadingId}
              setVerifyingId={setVerifyingId}
              apply={apply}
              load={load}
              currentDefault={resolved.models.defaultModel}
            />
          ))}
          {builtins.length === 0 && (
            <div className="models-empty">Loading built-in models…</div>
          )}
        </div>
      </section>

      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Ollama</h3>
            <p>Local models via Ollama’s OpenAI-compatible API.</p>
          </div>
        </header>
        <OllamaConfigPanel
          resolved={resolved}
          status={status}
          defaultModel={resolved.models.defaultModel}
          compact
          onSaveConnections={async (connections) => {
            await apply(['models', 'connections'], connections)
          }}
          onRefresh={async () => {
            await load()
          }}
          onSetDefaultModel={async (model) => {
            await apply(['models', 'defaultModel'], model)
          }}
        />
      </section>

      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Cloud &amp; other APIs</h3>
            <p>OpenAI, OpenRouter, LM Studio, and custom /v1 endpoints.</p>
          </div>
          <button type="button" className="btn" onClick={() => setShowApis((v) => !v)}>
            {showApis ? 'Hide' : 'Manage'}
          </button>
        </header>
        {showApis ? (
          <ModelConnectionsPanel
            resolved={resolved}
            status={status}
            defaultModel={resolved.models.defaultModel}
            compact
            onSaveConnections={async (connections) => {
              await apply(['models', 'connections'], connections)
            }}
            onRefresh={async () => {
              await load()
            }}
            onSetDefaultModel={async (model) => {
              await apply(['models', 'defaultModel'], model)
            }}
          />
        ) : (
          <ModelsApisSummary resolved={resolved} status={status} />
        )}
      </section>
    </div>
  )
}

function ModelsApisSummary({
  resolved,
  status
}: {
  resolved: AppSettings
  status: ModelsStatus | null
}) {
  const external = (resolved.models.connections ?? []).filter(
    (c) => c.type !== 'builtin' && c.provider !== 'ollama' && c.id !== 'ollama'
  )
  if (external.length === 0) {
    return (
      <div className="models-empty">No cloud providers yet. Click Manage to add one.</div>
    )
  }
  return (
    <ul className="models-summary-list">
      {external.map((c) => {
        const live = status?.connections?.find((x) => x.id === c.id)
        return (
          <li key={c.id}>
            <span className={`status-dot ${live?.reachable ? 'ok' : ''}`} />
            <strong>{c.name}</strong>
            <span className="models-row-meta">
              {c.enabled ? (live?.reachable ? 'Connected' : 'Offline') : 'Off'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
