import { ImageGenerationSettings } from '../ImageGenerationSettings'
import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  BuiltinModelStatus,
  ModelsStatus
} from '@/shared/settings-schema'
import { downloadStatusLabel } from '@/shared/model-download-ui'
import type { ApplySetting } from '../fields'
import { LocalModelsPanel } from '../LocalModelsPanel'
import { ModelConnectionsPanel } from '../ModelConnectionsPanel'
import { OllamaConfigPanel } from '../OllamaConfigPanel'
import { connectionModelRef, isLocalOllamaConnection } from '@/shared/eris-cloud'
import { isAutomaticModelSelection } from '@/shared/model-execution'
import { ModelCapabilityEditor } from './ModelCapabilityEditor'

export function useModelsPanelState() {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  return { downloadingId, setDownloadingId, verifyingId, setVerifyingId }
}

export type ModelsPanelState = ReturnType<typeof useModelsPanelState>

function sizeLabel(bytes: number): string {
  return bytes >= 1e9 ? `~${(bytes / 1e9).toFixed(1)} GB` : `~${Math.round(bytes / 1e6)} MB`
}

export function BuiltinRow({
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
  const statusText = downloadStatusLabel(
    { ...b, downloading: isDownloading },
    b.installed ? 'Needs re-download' : `Not installed · ${size}`
  )

  const baseModelLabel = [b.family, b.parameters, b.quant, size].filter(Boolean).join(' · ')

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
          <div className="models-row-base" title={b.filename}>
            <span className="models-base-label">Base model</span>
            <code>
              {b.family}-{b.parameters}-Instruct ({b.quant})
            </code>
            <span className="model-conn-meta">{baseModelLabel}</span>
          </div>
          {b.description ? <p className="models-row-desc">{b.description}</p> : null}
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
            Wait
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={startDownload}>
              {b.downloadError ? 'Retry' : b.installed ? 'Re-download' : 'Download'}
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

type SharedProps = {
  state: ModelsPanelState
  resolved: AppSettings
  status: ModelsStatus | null
  apply: ApplySetting
  load: () => Promise<void>
}

function DefaultModelCard({
  resolved,
  status,
  apply
}: {
  resolved: AppSettings
  status: ModelsStatus | null
  apply: ApplySetting
}) {
  const locals = status?.local ?? []
  const readyOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: 'auto', label: 'Auto' }]
    for (const m of locals) {
      if (m.ready) opts.push({ value: m.ref, label: m.displayName })
    }
    for (const c of status?.connections ?? []) {
      if (!c.reachable || c.type === 'builtin') continue
      for (const name of c.models || []) {
        if (name.startsWith('builtin:') || name.startsWith('local:')) continue
        const ref = connectionModelRef(c, name)
        if (!opts.some((option) => option.value === ref)) opts.push({ value: ref, label: `${name} · ${c.name}` })
      }
    }
    const def = resolved.models.defaultModel
    if (def && !opts.some((o) => o.value === def)) {
      opts.unshift({ value: def, label: `${def} (offline)` })
    }
    return opts
  }, [locals, status?.connections, resolved.models.defaultModel])

  return (
    <section className="models-card">
      <label className="models-default-field">
        <span>Primary model</span>
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
      <p className="models-hint">Primary model. Used for Ask / Agent and multi-step or editing work when you don’t pick another model in chat.</p>
      <label className="models-default-field">
        <span>Fast model</span>
        <select
          value={resolved.models.fast || 'auto'}
          onChange={(e) => void apply(['models', 'fast'], e.target.value)}
        >
          {readyOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value === 'auto' ? 'Auto-fast (cheapest eligible model)' : o.label}
            </option>
          ))}
        </select>
      </label>
      <p className="models-hint">Used by the Explainer and Fast roles and for short helper calls. Follows the same privacy policy as the primary model; with one model, both use it.</p>
      <ModelCapabilityEditor
        models={resolved.models}
        options={readyOptions.filter((option) => !isAutomaticModelSelection(option.value))}
        apply={apply}
      />
      <label className="models-default-field"><span>Auto preference</span>
        <select value={resolved.models.selectionPreference ?? 'best'} onChange={e => void apply(['models', 'selectionPreference'], e.target.value)}>
          <option value="best">Prefer best</option><option value="local">Prefer local</option><option value="cheapest">Prefer cheapest</option>
        </select>
      </label>
      <label className="models-default-field">
        <span>Recovery models (one model ID per line, in order)</span>
        <textarea
          key={resolved.models.fallbacks?.join('\n')}
          defaultValue={resolved.models.fallbacks?.join('\n')}
          onBlur={e => {
            const next = [...new Set(e.target.value.split('\n').map(model => model.trim()).filter(Boolean))]
            if (next.join('\n') !== (resolved.models.fallbacks ?? []).join('\n'))
              void apply(['models', 'fallbacks'], next)
          }}
        />
      </label>
      <label className="gpu-accel-toggle">
        <input type="checkbox" checked={resolved.agent.recoveryAcrossProviders === true}
          onChange={e => void apply(['agent', 'recoveryAcrossProviders'], e.target.checked)} />
        <span>Allow remote runs to recover on a different provider</span>
      </label>
    </section>
  )
}

/** Settings → Composer — built-in Lite/Full downloads + default model. */
export function ComposerModelsPanel({ resolved, status, apply }: SharedProps) {
  return <div className="models-page"><DefaultModelCard resolved={resolved} status={status} apply={apply} /><p>Download a text model or configure a provider. Eris Cloud models (hosted by EricServic.es) turn on when you sign in — see Settings → Models → Cloud Models.</p></div>
}

/** Settings → Text Models — local GGUF catalog and downloads. */
export function TextModelsPanel({ resolved, status, apply, load }: Omit<SharedProps, 'state'>) {
  const locals = status?.local ?? []

  return (
    <div className="models-page">
      <section className="models-card">
        <LocalModelsPanel
          models={locals}
          defaultModel={resolved.models.defaultModel}
          apply={apply}
          load={load}
        />
      </section>
    </div>
  )
}

/** Settings → Image Models — local Hugging Face downloads and API image models. */
export function ImageModelsPanel({ resolved, apply }: Pick<SharedProps, 'resolved' | 'apply'>) {
  return (
    <div className="models-page">
      <ImageGenerationSettings resolved={resolved} apply={apply} />
    </div>
  )
}

/** Settings → Providers — cloud/custom APIs first; Ollama as advanced. */
export function ProvidersModelsPanel({
  resolved,
  status,
  apply,
  load
}: Omit<SharedProps, 'state'>) {
  const [showOllama, setShowOllama] = useState(false)

  const ollamaLive = useMemo(() => {
    const conn = (resolved.models.connections ?? []).find(
      (c) => isLocalOllamaConnection(c)
    )
    if (!conn) return { present: false, reachable: false, enabled: false }
    const live = status?.connections?.find((c) => c.id === conn.id)
    return {
      present: true,
      enabled: conn.enabled !== false,
      reachable: Boolean(live?.reachable)
    }
  }, [resolved.models.connections, status])

  useEffect(() => {
    if (ollamaLive.present && ollamaLive.enabled) setShowOllama(true)
  }, [ollamaLive.present, ollamaLive.enabled])

  const saveConnections = async (connections: AppSettings['models']['connections']) => {
    await apply(['models', 'connections'], connections)
  }

  return (
    <div className="models-page providers-page">
      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>API providers</h3>
            <p>
              Optional. Chat models are configured under <strong>Text Models</strong>.
              Add a cloud API or local server when you need one.
            </p>
          </div>
        </header>

        <ModelConnectionsPanel
          resolved={resolved}
          status={status}
          defaultModel={resolved.models.defaultModel}
          compact
          onSaveConnections={saveConnections}
          onRefresh={async () => {
            await load()
          }}
          onSetDefaultModel={async (model) => {
            await apply(['models', 'defaultModel'], model)
          }}
        />
      </section>

      <section className={`models-card providers-advanced${showOllama ? ' is-open' : ''}`}>
        <button
          type="button"
          className="providers-advanced-toggle"
          aria-expanded={showOllama}
          onClick={() => setShowOllama((v) => !v)}
        >
          <span className="providers-advanced-title">
            <span
              className={`status-dot ${ollamaLive.reachable && ollamaLive.enabled ? 'ok' : ''}`}
            />
            <strong>Ollama daemon</strong>
            <span className="models-tag">Advanced</span>
          </span>
          <span className="providers-advanced-meta">
            {ollamaLive.reachable && ollamaLive.enabled
              ? 'Connected'
              : ollamaLive.present && !ollamaLive.enabled
                ? 'Disabled'
                : 'Optional · separate app'}
            <span className="providers-chevron" aria-hidden>
              {showOllama ? '▾' : '▸'}
            </span>
          </span>
        </button>
        {showOllama && (
          <div className="providers-advanced-body">
            <p className="models-hint">
              Only if you already run Ollama. Prefer <strong>Text Models</strong> for GGUFs that run
              inside Eris.
            </p>
            <OllamaConfigPanel
              resolved={resolved}
              status={status}
              defaultModel={resolved.models.defaultModel}
              compact
              onSaveConnections={saveConnections}
              onRefresh={async () => {
                await load()
              }}
              onSetDefaultModel={async (model) => {
                await apply(['models', 'defaultModel'], model)
              }}
            />
          </div>
        )}
      </section>
    </div>
  )
}

/** @deprecated Use ComposerModelsPanel — kept for any stray imports. */
export function ModelsPanel(props: SharedProps) {
  return <ComposerModelsPanel {...props} />
}
