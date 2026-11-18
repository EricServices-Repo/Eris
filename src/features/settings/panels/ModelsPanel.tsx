import { ImageGenerationSettings } from '../ImageGenerationSettings'
import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  ModelsStatus
} from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { LocalModelsPanel } from '../LocalModelsPanel'
import { ModelConnectionsPanel } from '../ModelConnectionsPanel'
import { OllamaConfigPanel } from '../OllamaConfigPanel'
import { connectionModelRef, primaryOllamaConnection } from '@/shared/eris-cloud'
import { isAutomaticModelSelection } from '@/shared/model-execution'
import { ModelCapabilityEditor } from './ModelCapabilityEditor'

type SharedProps = {
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
  const readyOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: 'auto', label: 'Auto' }]
    for (const m of status?.local ?? []) {
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
  }, [status?.local, status?.connections, resolved.models.defaultModel])

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

/** Settings → Models — primary and fast model defaults. */
export function ComposerModelsPanel({ resolved, status, apply }: Omit<SharedProps, 'load'>) {
  return <div className="models-page"><DefaultModelCard resolved={resolved} status={status} apply={apply} /><p>Download a text model or configure a provider. Eris Cloud models (hosted by EricServic.es) turn on when you sign in — see Settings → Models → Cloud Models.</p></div>
}

/** Settings → Text Models — local GGUF catalog and downloads. */
export function TextModelsPanel({ resolved, status, apply, load }: SharedProps) {
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
}: SharedProps) {
  const [showOllama, setShowOllama] = useState(false)

  const ollamaLive = useMemo(() => {
    const conn = primaryOllamaConnection(resolved.models.connections ?? [])
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
