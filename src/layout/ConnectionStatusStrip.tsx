import type { UsageEntitlement } from '@/shared/api'
import type { CloudHealth } from '@/shared/cloud-agents'

export type ConnectionIssue = {
  id: string
  tone: 'warn' | 'danger' | 'info'
  title: string
  detail?: string
  actionLabel?: string
  onAction?: () => void
}

interface Props {
  issues: ConnectionIssue[]
  onDismiss?: (id: string) => void
}

export function buildConnectionIssues(input: {
  accountNeedsReauth: boolean
  accountError?: string | null
  entitlement?: UsageEntitlement | null
  cloudHealth?: CloudHealth | null
  modelsOk?: boolean | null
  composerReady?: boolean | null
  onOpenAccount: () => void
  onOpenUsage: () => void
  onOpenUpgrade: () => void
  onOpenModels?: () => void
  onOpenAgent?: () => void
  onWorkLocal?: () => void
}): ConnectionIssue[] {
  const issues: ConnectionIssue[] = []

  if (input.accountNeedsReauth) {
    issues.push({
      id: 'auth',
      tone: 'danger',
      title: 'EricServic.es session expired',
      detail: input.accountError || 'Sign in again to restore sync and Cloud Agents.',
      actionLabel: 'Sign in',
      onAction: input.onOpenAccount
    })
  }

  if (input.entitlement?.overLimit) {
    issues.push({
      id: 'quota',
      tone: 'danger',
      title: 'Daily Free plan limit reached',
      detail: input.entitlement.blockedReason || undefined,
      actionLabel: 'Upgrade',
      onAction: input.onOpenUpgrade
    })
  }

  // Cloud Agents status lives in the status bar only (no top banner on timeout/offline).

  if (input.modelsOk === false) {
    issues.push({
      id: 'models',
      tone: 'warn',
      title: 'No local models ready',
      detail:
        input.composerReady === false
          ? 'Download Composer Lite or connect Ollama to chat.'
          : 'Model probe failed — check Settings → Models.',
      actionLabel: 'Models',
      onAction: input.onOpenModels
    })
  }

  return issues
}

export function ConnectionStatusStrip({ issues, onDismiss }: Props) {
  if (!issues.length) return null

  return (
    <div className="conn-strip" role="status">
      {issues.map((issue) => (
        <div key={issue.id} className={`conn-strip-item tone-${issue.tone}`}>
          <div className="conn-strip-copy">
            <strong>{issue.title}</strong>
            {issue.detail && <span>{issue.detail}</span>}
          </div>
          <div className="conn-strip-actions">
            {issue.actionLabel && issue.onAction && (
              <button type="button" className="btn" onClick={issue.onAction}>
                {issue.actionLabel}
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="btn-ghost"
                aria-label={`Dismiss ${issue.title}`}
                onClick={() => onDismiss(issue.id)}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
