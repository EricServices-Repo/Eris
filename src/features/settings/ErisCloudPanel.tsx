import { useState } from 'react'
import type { AppSettings, ModelConnection, ModelsStatus } from '@/shared/settings-schema'
import {
  ERIS_CLOUD_BASE_URL,
  erisCloudModelRef,
  isErisCloudConnection,
  normalizeErisCloudConnection,
  providerModelId
} from '@/shared/eris-cloud'

interface Props {
  resolved: AppSettings
  status: ModelsStatus | null
  onOpenAccount: () => void
  onSaveConnections: (connections: ModelConnection[]) => Promise<void>
  onRefresh: () => Promise<void>
  onSetDefaultModel: (model: string) => Promise<void>
}

export function ErisCloudPanel({
  resolved,
  status,
  onOpenAccount,
  onSaveConnections,
  onRefresh,
  onSetDefaultModel
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const conn = resolved.models.connections.find(isErisCloudConnection)
  const live = status?.connections.find(isErisCloudConnection)
  const signedIn = Boolean(resolved.ericServices?.linked)
  const enabled = Boolean(conn?.enabled)
  const connected = signedIn && enabled && live?.reachable === true && !refreshFailed
  const models = connected ? [...new Set(live.models.map(erisCloudModelRef))].sort() : []
  const connectionStatus = !signedIn
    ? 'Sign in required'
    : !enabled
      ? 'Disabled'
      : connected
        ? 'Connected'
        : live || refreshFailed
          ? 'Unavailable'
          : 'Checking connection…'

  async function run(action: () => Promise<void>, refresh = false) {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (refresh) setRefreshFailed(false)
    } catch (err) {
      if (refresh) setRefreshFailed(true)
      setError(err instanceof Error ? err.message : 'Could not update Eris Cloud.')
    } finally {
      setBusy(false)
    }
  }

  function toggleConnection() {
    const connections = resolved.models.connections.map((c) =>
      isErisCloudConnection(c) ? normalizeErisCloudConnection({ ...c, enabled: !enabled }) : c
    )
    return run(() => onSaveConnections(connections), true)
  }

  return (
    <div className="models-page">
      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>EricServic.es connection</h3>
            <p>Use your EricServic.es account to access Eris Cloud.</p>
          </div>
          {!signedIn ? (
            <button type="button" className="btn btn-primary" onClick={onOpenAccount}>
              Sign in
            </button>
          ) : conn ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void toggleConnection()}
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
          ) : null}
        </header>

        <div className="providers-ollama-status" role="status">
          <span className={`status-dot ${connected ? 'ok' : ''}`} aria-hidden="true" />
          <span>{connectionStatus}</span>
        </div>
        <p className="models-hint">
          <code>{ERIS_CLOUD_BASE_URL}</code>
        </p>
        {(error || (signedIn && enabled && !connected && live?.error)) && (
          <p className="models-inline-msg" data-tone="danger" role="alert">
            {error || live?.error}
          </p>
        )}
      </section>

      <section className="models-card">
        <header className="models-card-head">
          <div>
            <h3>Available models</h3>
            {connected && models.length > 0 && (
              <p>
                {models.length} {models.length === 1 ? 'model' : 'models'} offered by EricServic.es
              </p>
            )}
          </div>
          {signedIn && enabled && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(onRefresh, true)}
            >
              Refresh models
            </button>
          )}
        </header>
        {models.length > 0 ? (
          <div className="models-row-list">
            {models.map((ref) => {
              const isDefault = resolved.models.defaultModel === ref
              return (
                <div key={ref} className={`models-row${isDefault ? ' is-default' : ''}`}>
                  <div className="models-row-main">
                    <div className="models-row-copy">
                      <strong className="models-row-title">{providerModelId(ref)}</strong>
                      <div className="models-row-meta">
                        <code>{ref}</code>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || isDefault}
                    onClick={() => void run(() => onSetDefaultModel(ref))}
                  >
                    {isDefault ? 'Chat default' : 'Set as chat default'}
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="models-hint">
            {connected
              ? 'EricServic.es is connected. Its catalog is currently empty.'
              : !signedIn
                ? 'Sign in to see the current cloud model catalog.'
                : !enabled
                  ? 'Enable Eris Cloud to see its models.'
                  : 'The catalog will appear once Eris Cloud connects.'}
          </p>
        )}
      </section>
    </div>
  )
}
