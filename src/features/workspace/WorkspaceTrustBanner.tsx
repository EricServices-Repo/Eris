import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceTrustStatus } from '@/shared/api'

interface Props {
  workspacePath: string | null
  /** Called after trust changes so settings/models reload with the new layer */
  onTrustChanged: () => void
}

export function WorkspaceTrustBanner({ workspacePath, onTrustChanged }: Props) {
  const [status, setStatus] = useState<WorkspaceTrustStatus | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setStatus(null)
      return
    }
    setStatus(await window.ide.getWorkspaceTrust().catch(() => null))
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status || status.trusted || status.risky.length === 0) return null
  if (dismissed === status.workspacePath) return null

  return (
    <div className="composer-banner trust-banner" role="alert">
      <div>
        <strong>This folder&apos;s .eris/settings.json is restricted.</strong> Until you trust it,
        Eris ignores settings that would:
        <ul>
          {status.risky.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      <div className="trust-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            void window.ide.setWorkspaceTrust(true).then(() => {
              void refresh()
              onTrustChanged()
            })
          }}
        >
          Trust folder
        </button>
        <button className="btn" onClick={() => setDismissed(status.workspacePath)}>
          Keep restricted
        </button>
      </div>
    </div>
  )
}
