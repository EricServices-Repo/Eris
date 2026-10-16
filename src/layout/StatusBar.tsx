import type { ResolvedAgent } from '@/shared/settings-schema'
import type { CloudHealth } from '@/shared/cloud-agents'
import type { UpdateStatusSnapshot, UsageEntitlement } from '@/shared/api'
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
  entitlement?: UsageEntitlement | null
  accountNeedsReauth?: boolean
  appVersion?: string | null
  updateStatus?: UpdateStatusSnapshot | null
  disabled?: boolean
  onOpenSettings: () => void
  onOpenAgentSettings?: () => void
  onOpenModels?: () => void
  onOpenUsage?: () => void
  onOpenAccount?: () => void
  onCheckUpdates?: () => void
  onAgentChange: (agentId: string | 'auto') => void
}

function formatQuota(ent: UsageEntitlement): string {
  if (ent.plan === 'pro') return 'Pro · Unlimited'
  // Local chat is unlimited on Free; the only daily cap is Cloud Agent jobs.
  const left = ent.cloudJobs.remaining
  const limit = ent.cloudJobs.limit
  if (left == null || limit == null) return 'Free · local unlimited'
  return `Free · ${left}/${limit} cloud jobs`
}

/** green = ready, yellow = partial, red = none */
function modelsLight(
  composerReady: boolean,
  modelsOk: boolean
): { tone: 'ok' | 'warn' | 'danger'; label: string; title: string } {
  if (composerReady && modelsOk) {
    return {
      tone: 'ok',
      label: 'Models',
      title: 'Local / Composer models and connected providers are ready'
    }
  }
  if (composerReady && !modelsOk) {
    return {
      tone: 'ok',
      label: 'Models',
      title: 'Local or Composer model ready (external Ollama/API optional)'
    }
  }
  if (!composerReady && modelsOk) {
    return {
      tone: 'warn',
      label: 'Models',
      title: 'External providers ready · download a Local model or Composer Lite for offline chat'
    }
  }
  return {
    tone: 'danger',
    label: 'No models',
    title: 'No models ready — download a Local model or Composer Lite in Settings → Models'
  }
}

export function StatusBar({
  agents,
  selectedAgentId,
  routeLabel,
  composerReady,
  modelsOk,
  cloudHealth = null,
  entitlement = null,
  accountNeedsReauth = false,
  appVersion,
  updateStatus = null,
  disabled,
  onOpenSettings,
  onOpenAgentSettings,
  onOpenModels,
  onOpenUsage,
  onOpenAccount,
  onCheckUpdates,
  onAgentChange
}: Props) {
  const cloudReady = isCloudAgentsReady(cloudHealth)
  const preferCloud = shouldUseCloudAgents(cloudHealth)
  const cloudTitle = `${cloudAgentsStatusLabel(cloudHealth)}\n${CLOUD_AGENTS_BASE_URL} (plain HTTP)\nOpen Settings → Agent for metrics`
  const models = modelsLight(composerReady, modelsOk)

  let cloudLabel = 'Checking…'
  if (!cloudHealth) cloudLabel = 'Checking…'
  else if (accountNeedsReauth) cloudLabel = 'Re-auth'
  else if (cloudHealth.authenticated !== true) cloudLabel = 'Sign in'
  else if (cloudReady) cloudLabel = 'Cloud'
  else if (preferCloud) cloudLabel = 'Cloud…'
  else cloudLabel = 'Local agents'

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
          <button
            type="button"
            className={`status-bar-btn status-bar-version${
              updateStatus?.state === 'available' || updateStatus?.state === 'downloaded'
                ? ' is-warn'
                : ''
            }`}
            onClick={() => onCheckUpdates?.()}
            title={
              updateStatus?.state === 'available' || updateStatus?.state === 'downloaded'
                ? `Update ${updateStatus.availableVersion} ready — click to check`
                : `Eris v${appVersion} — check for updates`
            }
          >
            {updateStatus?.state === 'available' || updateStatus?.state === 'downloaded'
              ? `v${appVersion} ↑`
              : `v${appVersion}`}
          </button>
        )}
        <button
          type="button"
          className={`status-bar-btn${accountNeedsReauth ? ' is-warn' : ''}`}
          onClick={onOpenAgentSettings}
          title={cloudTitle}
        >
          <span
            className={`status-dot${preferCloud && !accountNeedsReauth ? ' ok' : ''}${
              accountNeedsReauth ? ' warn' : ''
            }`}
          />
          <span className="status-bar-label">{cloudLabel}</span>
        </button>
        {entitlement && (
          <button
            type="button"
            className={`status-bar-btn status-bar-plan${
              entitlement.overLimit || accountNeedsReauth ? ' is-warn' : ''
            }`}
            onClick={() => {
              if (accountNeedsReauth) onOpenAccount?.()
              else onOpenUsage?.()
            }}
            title={
              accountNeedsReauth
                ? 'Session expired — sign in again'
                : entitlement.blockedReason ||
                  `${entitlement.planLabel} plan · today ${entitlement.requests.used} requests` +
                    (entitlement.requests.limit != null
                      ? ` / ${entitlement.requests.limit}`
                      : ' (unlimited)')
            }
          >
            <span className="status-bar-plan-pill">{formatQuota(entitlement)}</span>
          </button>
        )}
      </div>

      <div className="status-bar-right" title={routeLabel || undefined}>
        <button
          type="button"
          className={`status-bar-btn status-bar-models tone-${models.tone}`}
          onClick={() => onOpenModels?.()}
          title={models.title}
        >
          <span className={`status-dot ${models.tone === 'ok' ? 'ok' : models.tone}`} />
          <span className="status-bar-models-label">{models.label}</span>
        </button>
        <span className="status-bar-divider" aria-hidden />
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
