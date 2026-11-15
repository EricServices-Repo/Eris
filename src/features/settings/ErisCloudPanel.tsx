import { useMemo, useState } from 'react'
import type { AppSettings, ModelConnection, ModelsStatus } from '@/shared/settings-schema'
import {
  ERIS_CLOUD_BASE_URL,
  erisCloudModelRef,
  isErisCloudConnection,
  normalizeErisCloudConnection
} from '@/shared/eris-cloud'

interface Props {
  resolved: AppSettings
  status: ModelsStatus | null
  defaultModel: string
  onSaveConnections: (connections: ModelConnection[]) => Promise<void>
  onRefresh: () => Promise<void>
  onSetDefaultModel: (model: string) => Promise<void>
}

/**
 * Hosted Ollama on EricServic.es (agents.ericservic.es). Authenticates with the
 * signed-in account's device token — there is no URL or key to enter.
 */
export function ErisCloudPanel({
  resolved,
  status,
  defaultModel,
  onSaveConnections,
  onRefresh,
  onSetDefaultModel
}: Props) {
  const conn = useMemo(
    () => (resolved.models.connections ?? []).find(isErisCloudConnection) ?? null,
    [resolved.models.connections]
  )
  const live = useMemo(
    () => (conn ? ((status?.connections ?? []).find((c) => c.id === conn.id) ?? null) : null),
    [status, conn]
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signedIn = Boolean(resolved.ericServices?.linked)
  const enabled = Boolean(conn?.enabled)
  const reachable = Boolean(live?.reachable)
  const models = live?.models?.length ? live.models : (conn?.models ?? [])

  const statusLabel = !signedIn
    ? 'Sign in required'
    : !enabled
      ? 'Off'
      : reachable
        ? models.length > 0
          ? `${models.length} model${models.length === 1 ? '' : 's'}`
          : 'Connected · no models on the server'
        : 'Offline'

  const save = async (nextEnabled: boolean) => {
    if (!conn) return
    setBusy(true)
    setError(null)
    try {
      const next = (resolved.models.connections ?? []).map((c) =>
        isErisCloudConnection(c) ? normalizeErisCloudConnection({ ...c, enabled: nextEnabled }) : c
      )
      await onSaveConnections(next)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Eris Cloud')
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ollama-config is-compact">
      <p className="models-hint">
        Models hosted by EricServic.es, served from <code>{ERIS_CLOUD_BASE_URL}</code>. Uses your
        EricServic.es sign-in — no API key needed.
      </p>

      <div className="providers-ollama-status">
        <span className={`status-dot ${signedIn && enabled && reachable ? 'ok' : ''}`} />
        <span>{statusLabel}</span>
        {conn && signedIn && (
          <div className="providers-ollama-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void save(!enabled)}>
              {enabled ? 'Disable' : 'Enable'}
            </button>
            {enabled && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>
                {busy ? '…' : 'Refresh'}
              </button>
            )}
          </div>
        )}
      </div>

      {!signedIn && (
        <div className="models-inline-msg" data-tone="ok">
          Sign in to your EricServic.es account under Settings → Account to use Eris Cloud models.
        </div>
      )}

      {signedIn && enabled && models.length > 0 && (
        <div className="providers-models-block">
          <span className="providers-models-label">Set chat default</span>
          <div className="model-chip-row">
            {models.map((id) => {
              // Saved as `cloud:<model>` so it never resolves to the same model on a local Ollama.
              const ref = erisCloudModelRef(id)
              return (
                <button
                  key={ref}
                  type="button"
                  className={`model-chip ${defaultModel === ref ? 'active' : ''}`}
                  title={`Use ${ref} (Eris Cloud) as default chat model`}
                  onClick={() => void onSetDefaultModel(ref)}
                >
                  {ref}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {(error || (enabled && !reachable && live?.error)) && (
        <div className="models-inline-msg" data-tone="danger">
          {error || live?.error}
        </div>
      )}
    </div>
  )
}
