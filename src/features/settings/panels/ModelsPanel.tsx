import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  BuiltinModelStatus,
  GpuAccelStatus,
  ModelsStatus
} from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { LocalModelsPanel } from '../LocalModelsPanel'
import { ModelConnectionsPanel } from '../ModelConnectionsPanel'
import { OllamaConfigPanel } from '../OllamaConfigPanel'

function GpuAccelCard({
  gpu,
  preferEgpu,
  apply,
  onRefresh
}: {
  gpu: GpuAccelStatus | null | undefined
  preferEgpu: boolean
  apply: ApplySetting
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const egpu = gpu?.egpu
  const tone = egpu
    ? gpu?.egpuUsable
      ? 'ok'
      : preferEgpu
        ? 'warn'
        : 'muted'
    : 'muted'

  const setPrefer = async (next: boolean) => {
    setBusy(true)
    try {
      await apply(['models', 'preferEgpu'], next)
      await window.ide.reloadLlamaGpu()
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="models-card gpu-accel-card">
      <header className="models-card-head">
        <div>
          <h3>GPU / eGPU</h3>
          <p>Local and Composer GGUFs can use an attached eGPU when available.</p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.ide
              .reloadLlamaGpu()
              .then(() => onRefresh())
              .finally(() => setBusy(false))
          }}
        >
          Rescan
        </button>
      </header>

      <div className={`gpu-accel-status is-${tone}`}>
        <span className={`status-dot ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : ''}`} />
        <div>
          <strong>
            {egpu
              ? gpu?.egpuUsable
                ? 'eGPU detected and usable'
                : 'eGPU detected'
              : 'No eGPU detected'}
          </strong>
          <p className="models-hint" style={{ margin: '4px 0 0' }}>
            {gpu?.message || 'Scanning GPUs…'}
          </p>
          {egpu && (
            <p className="model-conn-meta" style={{ marginTop: 6 }}>
              {egpu.name}
              {egpu.bus ? ` · ${egpu.bus}` : ''}
              {gpu?.backend ? ` · backend ${gpu.backend}` : ''}
              {gpu?.backendDeviceName ? ` · ${gpu.backendDeviceName}` : ''}
            </p>
          )}
          {!egpu && gpu?.backend && (
            <p className="model-conn-meta" style={{ marginTop: 6 }}>
              Active: {gpu.backend}
              {gpu.backendDeviceName ? ` · ${gpu.backendDeviceName}` : ''}
            </p>
          )}
        </div>
      </div>

      <label className="gpu-accel-toggle">
        <input
          type="checkbox"
          checked={preferEgpu}
          disabled={busy}
          onChange={(e) => void setPrefer(e.target.checked)}
        />
        <span>Prefer eGPU for Local models when attached</span>
      </label>
      <p className="models-hint">
        On macOS, also enable Finder → Eris → Get Info → <em>Prefer External GPU</em> if the
        checkbox is available. Windows uses CUDA/Vulkan device selection when present.
      </p>
    </section>
  )
}

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

  const baseModelLabel = [
    b.family,
    b.parameters,
    b.quant,
    size
  ]
    .filter(Boolean)
    .join(' · ')

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
  const builtins = status?.builtin ?? []
  const locals = status?.local ?? []
  const readyOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = []
    for (const b of builtins) {
      if (b.ready && b.tier !== 'full') {
        opts.push({ value: b.ref, label: b.displayName })
      }
    }
    for (const m of locals) {
      if (m.ready) opts.push({ value: m.ref, label: m.displayName })
    }
    for (const c of status?.connections ?? []) {
      if (!c.reachable || c.type === 'builtin') continue
      for (const name of c.models || []) {
        if (name.startsWith('builtin:') || name.startsWith('local:')) continue
        opts.push({ value: name, label: `${name} · ${c.name}` })
      }
    }
    const def = resolved.models.defaultModel
    if (def && !opts.some((o) => o.value === def)) {
      opts.unshift({ value: def, label: `${def} (offline)` })
    }
    return opts
  }, [builtins, locals, status?.connections, resolved.models.defaultModel])

  return (
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
  )
}

/** Settings → Composer — built-in Lite/Full downloads + default model. */
export function ComposerModelsPanel({
  state,
  resolved,
  status,
  apply,
  load
}: SharedProps) {
  const { downloadingId, setDownloadingId, verifyingId, setVerifyingId } = state
  const builtins = status?.builtin ?? []

  useEffect(() => {
    const active = builtins.find((b) => b.downloading)
    if (active) setDownloadingId(active.id)
  }, [builtins, setDownloadingId])

  return (
    <div className="models-page">
      <DefaultModelCard resolved={resolved} status={status} apply={apply} />

      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Composer</h3>
            <p>
              Built-in GGUFs. Lite = Qwen2.5-Coder 1.5B (local chat/tools) · Full = Qwen2.5-Coder 7B
              (Cloud Agents).
            </p>
          </div>
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
        </header>
        <p className="models-hint" style={{ marginTop: 0 }}>
          Downloads continue if you close Settings. On flaky networks, use Retry or Open URL in a
          browser to confirm Hugging Face is reachable. For a stronger local model without Cloud,
          use Settings → Local models (e.g. Qwen2.5-Coder 3B).
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
    </div>
  )
}

/** Settings → Local models — GGUF catalog + eGPU. */
export function LocalModelsSettingsPanel({
  resolved,
  status,
  apply,
  load
}: Omit<SharedProps, 'state'>) {
  const locals = status?.local ?? []

  return (
    <div className="models-page">
      <GpuAccelCard
        gpu={status?.gpu}
        preferEgpu={resolved.models.preferEgpu !== false}
        apply={apply}
        onRefresh={load}
      />

      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Local models</h3>
            <p>GGUFs that run inside Eris — no Ollama required.</p>
          </div>
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
        </header>
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

/** Settings → Providers — optional Ollama + cloud/custom APIs. */
export function ProvidersModelsPanel({
  resolved,
  status,
  apply,
  load
}: Omit<SharedProps, 'state'>) {
  return (
    <div className="models-page">
      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Ollama (optional)</h3>
            <p>Connect an existing Ollama install if you already use one.</p>
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
        </header>
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
      </section>
    </div>
  )
}

/** @deprecated Use ComposerModelsPanel — kept for any stray imports. */
export function ModelsPanel(props: SharedProps) {
  return <ComposerModelsPanel {...props} />
}
