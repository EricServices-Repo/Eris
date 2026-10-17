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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setStatus(null)
      return
    }
    try {
      setStatus(await window.ide.getWorkspaceTrust())
      setError(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Could not read workspace trust status')
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status) {
    if (!workspacePath || !error) return null
    return (
      <div className="composer-banner trust-banner" role="alert">
        <div>
          <strong>Could not check this workspace&apos;s trust settings.</strong> {error}
        </div>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    )
  }
  if (status.trusted || status.risky.length === 0) return null
  if (dismissed === status.workspacePath) return null

  return (
    <div className="composer-banner trust-banner" role="alert">
      <div>
        <strong>This folder&apos;s .eris/settings.json is restricted.</strong> Review the listed
        settings before trusting this workspace. Trust enables these project settings for this
        folder on this device:
        <ul>
          {status.risky.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      <div className="trust-actions">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await window.ide.setWorkspaceTrust(true)
              await refresh()
              onTrustChanged()
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not trust this workspace')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Applying…' : 'Trust folder'}
        </button>
        <button className="btn" onClick={() => setDismissed(status.workspacePath)}>
          Keep restricted
        </button>
      </div>
      {error && <div className="subtitle" role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  )
}
