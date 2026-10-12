import type { ResolvedAgent } from '@/shared/settings-schema'
import type { CloudHealth } from '@/shared/cloud-agents'
import {
  CLOUD_AGENTS_BASE_URL,
  cloudAgentsStatusLabel,
  isCloudAgentsReady,
  shouldUseCloudAgents
} from '@/shared/cloud-agents'

interface Props {
  agents: ResolvedAgent[]
  selectedAgentId: string | 'auto'
  routeLabel: string | null
  composerReady: boolean
  modelsOk: boolean
  cloudHealth?: CloudHealth | null
  appVersion?: string | null
  disabled?: boolean
  onOpenSettings: () => void
  onOpenAgentSettings?: () => void
  onAgentChange: (agentId: string | 'auto') => void
}

export function StatusBar({
  agents,
  selectedAgentId,
  routeLabel,
  composerReady,
  modelsOk,
  cloudHealth = null,
  appVersion,
  disabled,
  onOpenSettings,
  onOpenAgentSettings,
  onAgentChange
}: Props) {
  const cloudReady = isCloudAgentsReady(cloudHealth)
  const preferCloud = shouldUseCloudAgents(cloudHealth)
  const cloudTitle = `${cloudAgentsStatusLabel(cloudHealth)}\n${CLOUD_AGENTS_BASE_URL} (plain HTTP)\nOpen Settings → Agent for metrics`

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
        <button
          type="button"
          className="status-bar-btn"
          onClick={onOpenAgentSettings}
          title={cloudTitle}
        >
          <span className={`status-dot${preferCloud ? ' ok' : ''}`} />
          <span className="status-bar-label">
            {cloudReady
              ? 'Cloud'
              : preferCloud
                ? 'Cloud…'
                : cloudHealth && !cloudHealth.ok
                  ? 'Local agents'
                  : 'Cloud…'}
          </span>
        </button>
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
          {agents.map((a) => {
            // Only show a model when the agent overrides it. Empty model inherits
            // models.defaultModel (often Ollama) and should not clutter every row.
            const explicitModel = a.model.trim()
            return (
              <option key={a.id} value={a.id} title={a.resolvedModel || undefined}>
                {a.role === 'orchestrator' ? '◆ ' : ''}
                {a.name}
                {explicitModel ? ` · ${explicitModel}` : ''}
              </option>
            )
          })}
        </select>
        {routeLabel && <span className="status-bar-route">{routeLabel}</span>}
      </div>
    </footer>
  )
}
