import type { ResolvedAgent } from '@/shared/settings-schema'

interface Props {
  agents: ResolvedAgent[]
  selectedAgentId: string | 'auto'
  routeLabel: string | null
  composerReady: boolean
  modelsOk: boolean
  appVersion?: string | null
  disabled?: boolean
  onOpenSettings: () => void
  onAgentChange: (agentId: string | 'auto') => void
}

export function StatusBar({
  agents,
  selectedAgentId,
  routeLabel,
  composerReady,
  modelsOk,
  appVersion,
  disabled,
  onOpenSettings,
  onAgentChange
}: Props) {
  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        <button
          type="button"
          className="status-bar-btn"
          onClick={onOpenSettings}
          title="Settings (⌘,)"
        >
          <span className="status-bar-icon" aria-hidden>
            ⚙
          </span>
          Settings
        </button>
        {appVersion && (
          <span className="status-bar-version" title={`Eris v${appVersion}`}>
            v{appVersion}
          </span>
        )}
      </div>

      <div className="status-bar-right" title={routeLabel || undefined}>
        <span
          className={`status-dot ${modelsOk ? 'ok' : ''}`}
          title={
            composerReady
              ? 'Built-in Composer ready'
              : 'Download Composer Lite in Settings → Models (~1 GB)'
          }
        />
        <span className="status-bar-label">Agent</span>
        <select
          className="status-bar-select"
          value={selectedAgentId}
          disabled={disabled}
          onChange={(e) => onAgentChange(e.target.value as string | 'auto')}
          title="Auto route picks a specialist from your message"
        >
          <option value="auto">Auto route</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.role === 'orchestrator' ? '◆ ' : ''}
              {a.name}
              {a.resolvedModel ? ` · ${a.resolvedModel}` : ''}
            </option>
          ))}
        </select>
        {routeLabel && <span className="status-bar-route">{routeLabel}</span>}
      </div>
    </footer>
  )
}
