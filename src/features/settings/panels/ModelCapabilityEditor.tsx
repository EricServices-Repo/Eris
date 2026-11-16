import { useState } from 'react'
import { MAX_CONTEXT_TOKENS } from '@/shared/model-context'
import type { AppSettings } from '@/shared/settings-schema'
import type { ModelCapabilityProfile } from '@/shared/model-capability-profile'
import type { ApplySetting } from '../fields'

interface Props {
  models: AppSettings['models']
  options: Array<{ value: string; label: string }>
  apply: ApplySetting
}

export function ModelCapabilityEditor({ models, options, apply }: Props) {
  const [selection, setSelection] = useState('')
  const model = options.some((option) => option.value === selection) ? selection : options[0]?.value
  if (!model) return null
  const priority = [...new Set([...models.priority, ...options.map((option) => option.value)])]
  const index = priority.indexOf(model)
  const bump = (delta: number) => {
    const next = [...priority]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    next[index] = next[target]!
    next[target] = model
    return apply(['models', 'priority'], next)
  }
  const override = models.capabilityProfiles[model]
  const defaults: ModelCapabilityProfile = {
    tier: 'standard',
    toolCalling: 'text',
    contextWindow: models.contextWindow,
    reasoning: false,
    vision: false,
    costClass: model.startsWith('local:') ? 'free-local' : 'high'
  }
  return (
    <details>
      <summary>Auto model profiles and priority</summary>
      <label className="models-default-field">
        <span>Model</span>
        <select value={model} onChange={(event) => setSelection(event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <div className="models-default-field">
        <span>Priority {index + 1} of {priority.length}</span>
        <button type="button" className="btn" disabled={index <= 0} onClick={() => void bump(-1)}>Move up</button>
        <button type="button" className="btn" disabled={index >= priority.length - 1} onClick={() => void bump(1)}>Move down</button>
      </div>
      <ProfileFields key={model} model={model} current={override} defaults={defaults} apply={apply} />
    </details>
  )
}

function ProfileFields({ model, current, defaults, apply }: {
  model: string
  current?: ModelCapabilityProfile
  defaults: ModelCapabilityProfile
  apply: ApplySetting
}) {
  const [draft, setDraft] = useState(current ?? defaults)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async (enabled: boolean) => {
    setSaving(true)
    setError('')
    try {
      await apply(['models', 'capabilityProfiles', model], { ...draft, enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(true) }}>
      <p className="models-hint">{current && current.enabled !== false ? 'Using a custom profile.' : 'Using detected and bundled capabilities.'}</p>
      <label className="models-default-field"><span>Tier</span>
        <select value={draft.tier} onChange={(event) => setDraft({ ...draft, tier: event.target.value as ModelCapabilityProfile['tier'] })}>
          <option value="small">Small</option><option value="standard">Standard</option>
          <option value="strong">Strong</option><option value="frontier">Frontier</option>
        </select>
      </label>
      <label className="models-default-field"><span>Tool calling</span>
        <select value={draft.toolCalling} onChange={(event) => setDraft({ ...draft, toolCalling: event.target.value as ModelCapabilityProfile['toolCalling'] })}>
          <option value="native">Native</option><option value="text">Text</option><option value="none">None</option>
        </select>
      </label>
      <label className="models-default-field"><span>Context window</span>
        <input type="number" required min={512} max={MAX_CONTEXT_TOKENS} value={draft.contextWindow || ''}
          onChange={(event) => setDraft({ ...draft, contextWindow: Number(event.target.value) })} />
      </label>
      <label className="models-default-field"><span>Cost</span>
        <select value={draft.costClass} onChange={(event) => setDraft({ ...draft, costClass: event.target.value as ModelCapabilityProfile['costClass'] })}>
          <option value="free-local">Free local</option><option value="low">Low</option><option value="high">High</option>
        </select>
      </label>
      <label><input type="checkbox" checked={draft.reasoning} onChange={(event) => setDraft({ ...draft, reasoning: event.target.checked })} /> Reasoning</label>
      <label><input type="checkbox" checked={draft.vision} onChange={(event) => setDraft({ ...draft, vision: event.target.checked })} /> Vision</label>
      <div className="models-default-field">
        <button type="submit" className="btn btn-primary" disabled={saving}>Save profile</button>
        {current && current.enabled !== false && (
          <button type="button" className="btn" disabled={saving} onClick={() => void save(false)}>Use detected capabilities</button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}
