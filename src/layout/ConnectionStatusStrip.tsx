import type { UsageEntitlement } from '@/shared/api'

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
  onOpenAccount: () => void
  onOpenUsage: () => void
  onOpenUpgrade: () => void
}): ConnectionIssue[] {
  const issues: ConnectionIssue[] = []

  // Cloud Agents status stays in the StatusBar only — never a top banner /
  // load blocker. Offline cloud is expected when the worker is unreachable.

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
