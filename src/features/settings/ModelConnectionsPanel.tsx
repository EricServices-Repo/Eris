import { useMemo, useState } from 'react'
import type { AppSettings, ModelConnection, ModelsStatus } from '@/shared/settings-schema'

export type ConnectionPreset = {
  id: string
  name: string
  provider: string
  baseUrl: string
  requiresKey: boolean
  hint: string
}

const PRESETS: ConnectionPreset[] = [
  {
    id: 'lmstudio',
    name: 'LM Studio',
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresKey: false,
    hint: 'Start LM Studio’s local server, then Refresh models.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    hint: 'Cloud GPT models. Paste an API key from platform.openai.com.'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    hint: 'One key for many providers (Claude, GPT, Gemini, etc.).'
  },
  {
    id: 'groq',
    name: 'Groq',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    hint: 'Fast cloud inference. Keys from console.groq.com.'
  },
  {
    id: 'together',
    name: 'Together AI',
    provider: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    hint: 'Open-weight cloud models. Keys from api.together.xyz.'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    hint: 'DeepSeek chat/coder. Keys from platform.deepseek.com.'
  },
  {
    id: 'custom',
    name: 'Custom',
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:8000/v1',
    requiresKey: false,
    hint: 'Any OpenAI-compatible /v1 endpoint (vLLM, proxy, self-hosted).'
  }
]

type Draft = {
  toolProtocol?: ModelConnection['toolProtocol']
  id: string
  name: string
  provider: string
  baseUrl: string
  enabled: boolean
  modelsText: string
  apiKey: string
  /** True when editing an existing connection that already has a stored key */
  hasStoredKey: boolean
  isNew: boolean
}

function toDraft(conn: ModelConnection, hasStoredKey: boolean): Draft {
  return {
    id: conn.id,
    name: conn.name,
    toolProtocol: conn.toolProtocol,
    provider: conn.provider || 'custom',
    baseUrl: conn.baseUrl,
    enabled: conn.enabled,
    modelsText: conn.models.join(', '),
    apiKey: '',
    hasStoredKey,
    isNew: false
  }
}

function parseModels(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
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

export function ModelConnectionsPanel({
  resolved,
  status,
  defaultModel,
  compact = false,
  onSaveConnections,
  onRefresh,
  onSetDefaultModel
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Ollama has its own section on the Models page — exclude it here.
  const external = useMemo(
    () =>
      (resolved.models.connections ?? []).filter(
        (c) => c.type !== 'builtin' && c.provider !== 'ollama' && c.id !== 'ollama'
      ),
    [resolved.models.connections]
  )

  const statusById = useMemo(() => {
    const map = new Map<string, ModelsStatus['connections'][number]>()
    for (const c of status?.connections ?? []) {
      if (c.type !== 'builtin') map.set(c.id, c)
    }
    return map
  }, [status])

  const beginPreset = (preset: ConnectionPreset) => {
    setError(null)
    setInfo(null)
    setDraft({
      id: `conn-${preset.provider}-${Date.now().toString(36)}`,
      name: preset.name,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      enabled: true,
      modelsText: '',
      apiKey: '',
      hasStoredKey: false,
      isNew: true
    })
  }

  const beginEdit = async (conn: ModelConnection) => {
    setError(null)
    setInfo(null)
    const key = conn.apiKeyRef ? await window.ide.getSecret(conn.apiKeyRef) : null
    setDraft(toDraft(conn, Boolean(key)))
  }

  const saveDraft = async (alsoRefresh: boolean) => {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('Name is required')
      return
    }
    if (!draft.baseUrl.trim()) {
      setError('Base URL is required (should end with /v1)')
      return
    }
    const preset = PRESETS.find((p) => p.provider === draft.provider)
    if (preset?.requiresKey && !draft.apiKey && !draft.hasStoredKey) {
      setError(`${draft.name} needs an API key`)
      return
    }

    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const apiKeyRef = draft.apiKey || draft.hasStoredKey ? `connection.${draft.id}.apiKey` : ''
      if (draft.apiKey) {
        await window.ide.setSecret(apiKeyRef, draft.apiKey)
      }
      const nextConn: ModelConnection = {
        id: draft.id,
        name: draft.name.trim(),
        type: 'openai-compatible',
        provider: draft.provider || 'custom',
        toolProtocol: draft.toolProtocol ?? 'native-tools',
        enabled: draft.enabled,
        baseUrl: draft.baseUrl.trim().replace(/\/$/, ''),
        apiKeyRef,
        models: parseModels(draft.modelsText)
      }
      const others = resolved.models.connections.filter((c) => c.id !== draft.id)
      // Keep builtin first
      const builtin = others.filter((c) => c.type === 'builtin')
      const rest = others.filter((c) => c.type !== 'builtin')
      const connections = [...builtin, ...rest, nextConn]
      await onSaveConnections(connections)

      if (alsoRefresh) {
        await onRefresh()
        const after = await window.ide.modelsStatus({ probe: true })
        const live = after.connections.find((c) => c.id === draft.id)
        if (live?.reachable && (live.models?.length ?? 0) > 0) {
          const merged = {
            ...nextConn,
            models: live.models!.length > 0 ? live.models! : nextConn.models
          }
          const updated = connections.map((c) => (c.id === merged.id ? merged : c))
          await onSaveConnections(updated)
          setDraft({
            ...draft,
            modelsText: merged.models.join(', '),
            apiKey: '',
            hasStoredKey: Boolean(merged.apiKeyRef),
            isNew: false
          })
          setInfo(`Connected — ${merged.models.length} model(s) found`)
        } else if (live && !live.reachable) {
          setError(live.error || 'Could not reach this endpoint')
        } else {
          setInfo('Saved. Add model ids manually if discovery is empty.')
        }
      } else {
        setDraft({
          ...draft,
          apiKey: '',
          hasStoredKey: Boolean(apiKeyRef),
          isNew: false
        })
        setInfo('Saved')
      }
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connection')
    } finally {
      setBusy(false)
    }
  }

  const removeConnection = async (id: string) => {
    if (!window.confirm('Remove this model connection?')) return
    const connections = resolved.models.connections.filter((c) => c.id !== id)
    await onSaveConnections(connections)
    if (draft?.id === id) setDraft(null)
    await onRefresh()
  }

  const toggleEnabled = async (conn: ModelConnection) => {
    const connections = resolved.models.connections.map((c) =>
      c.id === conn.id ? { ...c, enabled: !c.enabled } : c
    )
    await onSaveConnections(connections)
    await onRefresh()
  }

  const activePreset = draft
    ? (PRESETS.find((p) => p.provider === draft.provider) ?? PRESETS[PRESETS.length - 1]!)
    : null

  const editor = draft && activePreset && (
    <div className="model-conn-editor">
      <div className="model-conn-row-head" style={{ marginBottom: 8 }}>
        <strong>{draft.isNew ? `Add ${draft.name}` : `Edit ${draft.name}`}</strong>
        <span className="badge">{draft.provider}</span>
      </div>
      <p className="model-conn-hint">{activePreset.hint}</p>
      <label className="field">
        <span>Name</span>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      {(activePreset.requiresKey || Boolean(draft.apiKey || draft.hasStoredKey)) && (
        <p className="model-conn-hint">
          Prompts and attached files are sent to this endpoint. The API key is stored in Eris&apos;s
          local app data on this device; anyone with access to your account files may be able to
          read it.
        </p>
      )}
      <label className="field">
        <span>Base URL</span>
        <input
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <label className="field">
        <span>
          API key
          {activePreset.requiresKey ? ' (required)' : ' (optional)'}
          {draft.hasStoredKey ? ' · saved' : ''}
        </span>
        <input
          type="password"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          placeholder={draft.hasStoredKey ? '•••••••• (leave blank to keep)' : 'sk-…'}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span>Models (comma-separated; leave empty to auto-discover)</span>
        <textarea
          rows={2}
          value={draft.modelsText}
          onChange={(e) => setDraft({ ...draft, modelsText: e.target.value })}
          placeholder="gpt-4o-mini, llama3.2, …"
          spellCheck={false}
        />
      </label>
      <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        <span>Enabled</span>
      </label>
      {error && (
        <div className="subtitle" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      {info && !error && (
        <div className="subtitle" style={{ color: 'var(--success, #3d9a5f)' }}>
          {info}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void saveDraft(true)}
        >
          {busy ? 'Working…' : 'Save & refresh'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void saveDraft(false)}>
          Save
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setDraft(null)
            setError(null)
            setInfo(null)
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )

  if (compact) {
    // Focused editor: hide the list so add/edit is one clear task.
    if (draft && activePreset) {
      return (
        <div className="model-connections is-compact providers-editor-focus">
          <div className="providers-editor-bar">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null)
                setError(null)
                setInfo(null)
              }}
            >
              ← Back
            </button>
            <strong>{draft.isNew ? `Add ${activePreset.name}` : `Edit ${draft.name}`}</strong>
          </div>
          <p className="model-conn-hint">{activePreset.hint}</p>
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          {(activePreset.requiresKey || Boolean(draft.apiKey || draft.hasStoredKey)) && (
            <p className="model-conn-hint">
              Prompts and attached files go to this provider. The API key is stored in Eris&apos;s
              local app data on this device; anyone with access to your account files may be able to
              read it.
            </p>
          )}
          <label className="field">
            <span>Base URL</span>
            <input
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>
              API key
              {activePreset.requiresKey ? '' : ' (optional)'}
              {draft.hasStoredKey ? ' · saved on this device' : ''}
            </span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder={draft.hasStoredKey ? 'Leave blank to keep current key' : 'sk-…'}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Models (optional — leave empty to discover)</span>
            <textarea
              rows={2}
              value={draft.modelsText}
              onChange={(e) => setDraft({ ...draft, modelsText: e.target.value })}
              placeholder="gpt-4o-mini, …"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Tool support</span>
            <select
              value={draft.toolProtocol ?? 'native-tools'}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  toolProtocol: event.target.value as ModelConnection['toolProtocol']
                })
              }
            >
              <option value="native-tools">Native tool calls</option>
              <option value="text-tools">Text tool format (compatibility)</option>
            </select>
          </label>
          <label className="providers-enable-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            <span>Enabled for chat</span>
          </label>
          {(error || info) && (
            <div className="models-inline-msg" data-tone={error ? 'danger' : 'ok'}>
              {error || info}
            </div>
          )}
          <div className="providers-editor-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void saveDraft(true)}
            >
              {busy ? 'Working…' : draft.isNew ? 'Connect' : 'Save & test'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void saveDraft(false)}
            >
              Save without testing
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="model-connections is-compact">
        <div className="providers-preset-grid" role="list">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="providers-preset-btn"
              role="listitem"
              title={p.hint}
              onClick={() => beginPreset(p)}
            >
              <strong>{p.name}</strong>
              <span>{p.requiresKey ? 'API key' : 'Local'}</span>
            </button>
          ))}
        </div>

        {external.length === 0 ? (
          <div className="providers-empty">
            <p>No API providers yet.</p>
            <p className="models-hint">Pick one above — OpenRouter is a good all-around start.</p>
          </div>
        ) : (
          <div className="models-row-list providers-conn-list">
            {external.map((c) => {
              const live = statusById.get(c.id)
              const models = live?.models?.length ? live.models : c.models
              const statusText = !c.enabled
                ? 'Off'
                : live?.reachable
                  ? models.length
                    ? `${models.length} model${models.length === 1 ? '' : 's'}`
                    : 'Connected'
                  : live?.error || 'Offline'
              return (
                <div
                  key={c.id}
                  className={`models-row providers-conn-row ${c.enabled ? '' : 'is-disabled'}`}
                >
                  <div className="models-row-main">
                    <span className={`status-dot ${live?.reachable && c.enabled ? 'ok' : ''}`} />
                    <div className="models-row-copy">
                      <div className="models-row-title">
                        <strong>{c.name}</strong>
                        <span className="models-tag">{c.provider || 'custom'}</span>
                        {!c.enabled && <span className="models-tag">Off</span>}
                        {c.enabled && models.includes(defaultModel) && (
                          <span className="models-tag is-accent">Default</span>
                        )}
                      </div>
                      <div className="models-row-meta" title={c.baseUrl}>
                        {statusText}
                        {c.enabled && live?.reachable
                          ? ` · ${c.baseUrl.replace(/^https?:\/\//, '')}`
                          : ''}
                      </div>
                    </div>
                  </div>
                  <div className="models-row-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void beginEdit(c)}
                    >
                      Edit
                    </button>
                    <button type="button" className="btn" onClick={() => void toggleEnabled(c)}>
                      {c.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      title="Remove connection"
                      onClick={() => void removeConnection(c.id)}
                    >
                      Remove
                    </button>
                  </div>
                  {models.length > 0 && c.enabled && (
                    <div className="providers-models-block">
                      <span className="providers-models-label">Set chat default</span>
                      <div className="model-chip-row models-row-chips">
                        {models.slice(0, 8).map((m) => (
                          <button
                            key={m}
                            type="button"
                            className={`model-chip ${defaultModel === m ? 'active' : ''}`}
                            title={`Use ${m} as default chat model`}
                            onClick={() => void onSetDefaultModel(m)}
                          >
                            {m}
                          </button>
                        ))}
                        {models.length > 8 && (
                          <span className="models-row-meta">+{models.length - 8}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="model-connections">
      <div className="model-connections-intro">
        <strong>Cloud &amp; other APIs</strong>
        <p>
          Add LM Studio, OpenAI, OpenRouter, or any OpenAI-compatible endpoint. Ollama is configured
          in its own section above. These connections appear in the model picker when reachable.
        </p>
      </div>

      <div className="model-preset-grid">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="model-preset-card"
            onClick={() => beginPreset(p)}
            title={p.hint}
          >
            <strong>{p.name}</strong>
            <span>{p.requiresKey ? 'API key' : 'Local / no key'}</span>
          </button>
        ))}
      </div>

      {external.length > 0 && (
        <div className="model-conn-list">
          {external.map((c) => {
            const live = statusById.get(c.id)
            const models = live?.models?.length ? live.models : c.models
            return (
              <div key={c.id} className={`model-conn-row ${c.enabled ? '' : 'disabled'}`}>
                <div className="model-conn-row-head">
                  <span className={`status-dot ${live?.reachable ? 'ok' : ''}`} />
                  <strong>{c.name}</strong>
                  <span className="badge">{c.provider || 'custom'}</span>
                  {!c.enabled && <span className="badge">off</span>}
                  {defaultModel && models.includes(defaultModel) && (
                    <span className="badge">default</span>
                  )}
                </div>
                <div className="model-conn-meta">
                  {c.baseUrl}
                  {live?.error ? ` · ${live.error}` : ''}
                  {live?.reachable && models.length === 0 ? ' · connected (no models listed)' : ''}
                </div>
                {models.length > 0 && (
                  <div className="model-chip-row">
                    {models.slice(0, 12).map((m) => (
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
                    {models.length > 12 && (
                      <span className="model-conn-meta">+{models.length - 12} more</span>
                    )}
                  </div>
                )}
                <div className="model-conn-actions">
                  <button type="button" className="btn" onClick={() => void beginEdit(c)}>
                    Edit
                  </button>
                  <button type="button" className="btn" onClick={() => void toggleEnabled(c)}>
                    {c.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="btn" onClick={() => void removeConnection(c.id)}>
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editor}
    </div>
  )
}
