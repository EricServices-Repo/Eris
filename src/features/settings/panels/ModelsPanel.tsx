import { InferenceAdmission } from '../InferenceAdmission'
import { ImageGenerationSettings } from '../ImageGenerationSettings'
import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  BuiltinModelStatus,
  GpuAccelStatus,
  ModelsStatus
} from '@/shared/settings-schema'
import { downloadStatusLabel } from '@/shared/model-download-ui'
import type { ApplySetting } from '../fields'
import { LocalModelsPanel } from '../LocalModelsPanel'
import { ModelConnectionsPanel } from '../ModelConnectionsPanel'
import { OllamaConfigPanel } from '../OllamaConfigPanel'

function gpuKindLabel(
  kind: 'integrated' | 'discrete' | 'external',
  name: string,
  backend?: GpuAccelStatus['backend']
): string {
  if (kind === 'external') return 'eGPU'
  if (/apple\s+m\d/i.test(name) || backend === 'metal') return 'Metal'
  if (kind === 'discrete') return 'GPU'
  return 'Integrated'
}

function modelPlacementLabel(loaded: NonNullable<GpuAccelStatus['loadedModel']>): string {
  const window = `${Math.round(loaded.contextSize / 1024)}K window`
  const layers =
    loaded.gpuLayers !== undefined && loaded.totalLayers !== undefined
      ? `${loaded.gpuLayers}/${loaded.totalLayers} layers on ${loaded.device ?? 'GPU'}`
      : (loaded.device ?? '')
  const kv = loaded.kvBytes ? formatMemoryStat('', loaded.kvBytes) : null
  return [layers, window, kv ? `about ${kv} KV` : ''].filter(Boolean).join(' · ')
}

function formatMemoryStat(name: string, bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const size =
    bytes >= 1e9
      ? `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`
      : `${Math.round(bytes / 1e6)} MB`
  if (/apple\s+m\d/i.test(name)) return `Unified ${size}`
  return size
}

function gpuStatLine(d: {
  name: string
  bus?: string
  vramBytes?: number
  vramFreeBytes?: number
  shared?: boolean
}): string {
  const parts: string[] = []
  if (d.shared && d.vramFreeBytes) {
    parts.push(`${formatMemoryStat(d.name, d.vramFreeBytes)} free`)
  }
  const mem = formatMemoryStat(d.name, d.vramBytes)
  if (mem) parts.push(mem)
  if (d.bus) parts.push(d.bus)
  return parts.join(' · ')
}

function GpuAccelCard({
  gpu,
  preferEgpu,
  allowCpuSpill,
  apply,
  onRefresh
}: {
  gpu: GpuAccelStatus | null | undefined
  preferEgpu: boolean
  allowCpuSpill: boolean
  apply: ApplySetting
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  const setSpill = async (next: boolean) => {
    setBusy(true)
    try {
      await apply(['models', 'allowCpuSpill'], next)
      await window.ide.reloadLlamaGpu()
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }
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

  const devices = gpu?.devices ?? []
  const shared = devices.filter((d) => d.shared)
  const preferredId = gpu?.preferredGpu
    ? `${gpu.preferredGpu.index}:${gpu.preferredGpu.name}`
    : null

  return (
    <section className="models-card gpu-accel-card">
      <header className="models-card-head">
        <div>
          <h3>GPU</h3>
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

      {gpu?.vramBudgetBytes && shared.length < 2 ? (
        <p className="gpu-share-vram">
          <span>Available for models</span>
          <strong>{formatMemoryStat('', gpu.vramBudgetBytes)}</strong>
          <span className="model-conn-meta">
            used to choose the quant, context length, and GPU layers
          </span>
        </p>
      ) : null}

      {gpu?.loadedModel ? (
        <p className="gpu-share-vram">
          <span>Loaded model</span>
          <strong>{modelPlacementLabel(gpu.loadedModel)}</strong>
          {gpu.loadedModel.gpuLayers !== undefined &&
          gpu.loadedModel.totalLayers !== undefined &&
          gpu.loadedModel.gpuLayers < gpu.loadedModel.totalLayers ? (
            <span className="model-conn-meta">
              Some layers run on the CPU, which is much slower. A smaller model will fit fully.
            </span>
          ) : null}
        </p>
      ) : null}

      {shared.length >= 2 && (
        <p className="gpu-share-vram">
          <span>Shared VRAM</span>
          <strong>
            {gpu?.vramShareFreeBytes != null
              ? `${formatMemoryStat('', gpu.vramShareFreeBytes)} free`
              : formatMemoryStat('', gpu?.vramShareTotalBytes)}
          </strong>
          <span className="model-conn-meta">
            {gpu?.vramShareFreeBytes != null && gpu.vramShareTotalBytes
              ? `of ${formatMemoryStat('', gpu.vramShareTotalBytes)} across ${shared.length} GPUs`
              : `across ${shared.length} GPUs`}
          </span>
        </p>
      )}

      <div className="gpu-device-list">
        {devices.length === 0 ? (
          <p className="models-hint">No GPUs found</p>
        ) : (
          <ul>
            {devices.map((d) => {
              const id = `${d.index}:${d.name}`
              const selected = preferEgpu && id === preferredId
              const stats = gpuStatLine(d)
              const tag = gpuKindLabel(d.kind, d.name, gpu?.backend)
              return (
                <li
                  key={id}
                  className={
                    [selected ? 'is-selected' : '', d.shared ? 'is-shared' : '']
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                >
                  <span
                    className={`gpu-kind-tag kind-${d.kind}${tag === 'Metal' ? ' kind-metal' : ''}`}
                  >
                    {tag}
                  </span>
                  <div className="gpu-device-copy">
                    <strong>{d.name}</strong>
                    {stats ? <span className="model-conn-meta">{stats}</span> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <label className="gpu-accel-toggle">
        <input
          type="checkbox"
          checked={preferEgpu}
          disabled={busy}
          onChange={(e) => void setPrefer(e.target.checked)}
        />
        <span>Prefer best GPU</span>
      </label>
      <label className="gpu-accel-toggle">
        <input
          type="checkbox"
          checked={allowCpuSpill}
          disabled={busy}
          onChange={(e) => void setSpill(e.target.checked)}
        />
        <span>Allow CPU layers when a model cannot fit on the GPU</span>
      </label>
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
  return bytes >= 1e9 ? `~${(bytes / 1e9).toFixed(1)} GB` : `~${Math.round(bytes / 1e6)} MB`
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
function LocalComposerToggle({
  resolved,
  builtins,
  apply
}: {
  resolved: AppSettings
  builtins: BuiltinModelStatus[]
  apply: ApplySetting
}) {
  const full = builtins.find((model) => model.tier === 'full' || model.id === 'composer')
  const fullReady = Boolean(full?.ready)
  const saved = resolved.agent.routing.useLocalComposerFull === true
  const checked = fullReady && saved

  return (
    <label className="gpu-accel-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={!fullReady}
        onChange={(event) => {
          if (!fullReady) return
          void apply(['agent', 'routing', 'useLocalComposerFull'], event.target.checked)
        }}
      />
      <span>
        <strong>Don’t use Cloud Composer</strong>
        <span className="model-conn-meta">
          {fullReady
            ? 'Composer Full runs on this Mac.'
            : 'Download Composer Full before you can turn Cloud Composer off.'}
        </span>
      </span>
    </label>
  )
}

/** Settings → Composer — built-in Lite/Full downloads + default model. */
export function ComposerModelsPanel({ state, resolved, status, apply, load }: SharedProps) {
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
              Built-in GGUFs. Lite runs on this Mac. Full runs on Cloud Agents unless you download
              it and turn off Cloud Composer.
            </p>
          </div>
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
        </header>
        <LocalComposerToggle resolved={resolved} builtins={builtins} apply={apply} />
        <p className="models-hint" style={{ marginTop: 0 }}>
          Downloads continue if you close Settings. On flaky networks, use Retry or Open URL in a
          browser to confirm Hugging Face is reachable. For a stronger local model without Cloud,
          use Settings → Text Models (e.g. Qwen2.5-Coder 3B).
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
          {builtins.length === 0 && <div className="models-empty">Loading built-in models…</div>}
        </div>
      </section>
    </div>
  )
}

/** Settings → GPUs — detected accelerators and eGPU preference. */
export function GpuModelsPanel({ resolved, status, apply, load }: Omit<SharedProps, 'state'>) {
  return (
    <div className="models-page">
      <InferenceAdmission />
      <GpuAccelCard
        gpu={status?.gpu}
        preferEgpu={resolved.models.preferEgpu !== false}
        allowCpuSpill={resolved.models.allowCpuSpill !== false}
        apply={apply}
        onRefresh={load}
      />
    </div>
  )
}

/** Settings → Text Models — local GGUF catalog and downloads. */
export function TextModelsPanel({ resolved, status, apply, load }: Omit<SharedProps, 'state'>) {
  const locals = status?.local ?? []

  return (
    <div className="models-page">
      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Text models</h3>
            <p>Download GGUF chat and coding models that run inside Eris — no Ollama required.</p>
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
      (c) => c.type !== 'builtin' && (c.provider === 'ollama' || c.id === 'ollama')
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
              Optional. Most chats use <strong>Composer</strong> or <strong>Text Models</strong>.
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
