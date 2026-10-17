import type { AgentDefinition } from '@/shared/settings-schema'

export function AgentEditor({
  agent,
  role,
  models,
  defaultModel,
  onChange,
  onRemove
}: {
  agent: AgentDefinition
  role: 'orchestrator' | 'specialist'
  models: string[]
  defaultModel: string
  onChange: (next: AgentDefinition) => void
  onRemove?: () => void
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 10,
        background: 'var(--bg)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong>{agent.name || agent.id}</strong>
          <span className="badge">{role}</span>
          {agent.builtin && <span className="badge">default</span>}
          <span className="badge">{agent.id}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={agent.enabled}
              onChange={(e) => onChange({ ...agent, enabled: e.target.checked })}
            />
            Enabled
          </label>
          {onRemove && (
            <button className="btn-ghost" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Name</label>
        <input value={agent.name} onChange={(e) => onChange({ ...agent, name: e.target.value })} />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Model</label>
        <select
          value={agent.model === 'builtin:composer' ? 'builtin:composer' : 'builtin:composer-lite'}
          onChange={(e) => onChange({ ...agent, model: e.target.value })}
          title={`Agents run Composer Lite or Composer Full. Chat default is ${defaultModel || 'Composer Lite'}.`}
        >
          <option value="builtin:composer-lite">Composer Lite</option>
          <option value="builtin:composer">Composer Full</option>
        </select>
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Temperature</label>
        <input
          type="number"
          step={0.1}
          min={0}
          max={2}
          value={agent.temperature ?? ''}
          placeholder="default"
          onChange={(e) =>
            onChange({
              ...agent,
              temperature: e.target.value === '' ? null : Number(e.target.value)
            })
          }
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Description</label>
        <input
          value={agent.description}
          onChange={(e) => onChange({ ...agent, description: e.target.value })}
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Keywords</label>
        <input
          value={agent.keywords.join(', ')}
          placeholder="implement, refactor, bug"
          onChange={(e) =>
            onChange({
              ...agent,
              keywords: e.target.value
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
            })
          }
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Tools</label>
        <select
          value={agent.tools ?? 'edit'}
          onChange={(e) =>
            onChange({
              ...agent,
              tools: e.target.value as AgentDefinition['tools']
            })
          }
          title="Max tool access this agent may use"
        >
          <option value="none">none — answer only</option>
          <option value="read">read — inspect files</option>
          <option value="edit">edit — read + write</option>
          <option value="full">full — edit + shell/git sync</option>
        </select>
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Escalate</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={agent.preferEscalate !== false}
            onChange={(e) => onChange({ ...agent, preferEscalate: e.target.checked })}
          />
          Allow Lite → Full for tools
        </label>
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>System prompt</label>
        <textarea
          rows={4}
          value={agent.systemPrompt}
          onChange={(e) => onChange({ ...agent, systemPrompt: e.target.value })}
        />
      </div>
      <datalist id="ollama-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}
