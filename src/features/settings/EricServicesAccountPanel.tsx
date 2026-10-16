import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, SettingsScope } from '@/shared/settings-schema'

type AccountStatus = Awaited<ReturnType<typeof window.ide.ericServicesStatus>>

interface Props {
  resolved: AppSettings
  scope: SettingsScope
  onScopeChange: (scope: SettingsScope) => void
  onApply: (path: string[], value: unknown) => Promise<void>
  onChanged: () => Promise<void>
}

function formatSyncedAt(raw: string | null | undefined): string {
  if (!raw) return 'Never'
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return raw
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(ms))
}

export function EricServicesAccountPanel({
  resolved,
  scope,
  onScopeChange,
  onApply,
  onChanged
}: Props) {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [apiBase, setApiBase] = useState(
    resolved.ericServices?.apiBase || 'https://www.ericservic.es'
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [devices, setDevices] = useState<
    Array<{ id: number; name: string; prefix: string; lastUsedAt: string | null; current: boolean }>
  >([])
  const [syncNotes, setSyncNotes] = useState<string[]>([])
  const [missingKeys, setMissingKeys] = useState<Array<{ id: string; name: string }>>([])

  const refresh = useCallback(async () => {
    try {
      const s = await window.ide.ericServicesStatus()
      setStatus(s)
      if (s.apiBase) setApiBase(s.apiBase)
      if (s.username && !username) setUsername(s.username)
      if (s.linked && s.hasToken && !s.needsReauth) {
        const listed = await window.ide.ericServicesDevices()
        setDevices(listed.devices || [])
      } else {
        setDevices([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account status')
    }
  }, [username])

  useEffect(() => {
    void refresh()
  }, [refresh, resolved.ericServices?.linked, resolved.ericServices?.username])

  useEffect(() => {
    setApiBase(resolved.ericServices?.apiBase || 'https://www.ericservic.es')
  }, [resolved.ericServices?.apiBase])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account action failed')
    } finally {
      setBusy(false)
    }
  }

  const needsReauth = Boolean(status?.needsReauth)
  const linked = Boolean(status?.linked && status?.hasToken && !needsReauth)
  const planLabel = (status?.plan || status?.profile?.erisPlan) === 'pro' ? 'Pro' : 'Free'
  const syncEnabled = resolved.ericServices?.syncEnabled !== false

  const identity = useMemo(() => {
    if (status?.username) return `@${status.username}`
    if (resolved.ericServices?.username) return `@${resolved.ericServices.username}`
    return null
  }, [status?.username, resolved.ericServices?.username])

  return (
    <div className="es-account">
      <header className="es-account-hero">
        <div>
          <h2 className="es-account-title">EricServic.es</h2>
          <p className="es-account-lead">
            Link your Control Hub account to sync profile settings across machines. Secrets and API
            keys stay on this device.
          </p>
        </div>
        <div className="es-account-hero-actions">
          <select
            className="scope-select"
            value={scope}
            onChange={(e) => onScopeChange(e.target.value as SettingsScope)}
            aria-label="Settings scope"
          >
            <option value="user">User</option>
            <option value="workspace" disabled>
              Workspace
            </option>
          </select>
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {status && (
        <section className={`es-account-card${needsReauth ? ' is-warn' : linked ? ' is-ok' : ''}`}>
          <div className="es-account-card-top">
            <div className="es-account-identity">
              <span className={`status-dot ${linked ? 'ok' : needsReauth ? 'warn' : ''}`} />
              <div>
                <div className="es-account-state">
                  {needsReauth ? 'Session expired' : linked ? 'Signed in' : 'Not signed in'}
                </div>
                {(identity || status.email) && (
                  <div className="es-account-meta">
                    {identity}
                    {identity && status.email ? ' · ' : ''}
                    {status.email}
                  </div>
                )}
              </div>
            </div>
            {linked && <span className="es-plan-pill">{planLabel}</span>}
          </div>

          {needsReauth && (
            <div className="es-account-banner">
              Your device token is no longer valid. Sign in again to restore sync and Cloud Agents.
            </div>
          )}

          {linked && (
            <dl className="es-account-stats">
              <div>
                <dt>Last synced</dt>
                <dd>{formatSyncedAt(status.lastSyncedAt)}</dd>
              </div>
              <div>
                <dt>Sync on sign-in</dt>
                <dd>{syncEnabled ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt>API</dt>
                <dd className="es-account-ellipsis" title={status.apiBase}>
                  {status.apiBase.replace(/^https?:\/\//, '')}
                </dd>
              </div>
            </dl>
          )}

          <div className="es-account-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void window.ide.ericServicesOpenAccount()}
            >
              Open account
            </button>
            {linked && planLabel !== 'Pro' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void window.ide.ericServicesOpenUpgrade()}
              >
                Upgrade to Pro
              </button>
            )}
          </div>
        </section>
      )}

      {(!linked || needsReauth) && (
        <section className="es-account-section">
          <h3>{needsReauth ? 'Sign in again' : 'Sign in'}</h3>
          <p className="es-account-hint">
            Use your EricServic.es username and password. Eris stores a device token only — never
            your password.
          </p>
          {showAdvanced && (
            <label className="field">
              <span>API base</span>
              <input
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://www.ericservic.es"
              />
            </label>
          )}
          <div className="es-account-form-grid">
            <label className="field">
              <span>Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                autoComplete="username"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </label>
          </div>
          <div className="es-account-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await onApply(['ericServices', 'apiBase'], apiBase.trim())
                  setMessage('Waiting for approval in the browser…')
                  const result = await window.ide.ericServicesLoginBrowser({
                    apiBase: apiBase.trim()
                  })
                  if (!result.ok) {
                    setError(result.error || 'Browser sign-in failed')
                    return
                  }
                  setSyncNotes(result.sync?.changes || [])
                  setMissingKeys(result.sync?.missingKeys || [])
                  setMessage(
                    result.profile?.username
                      ? `Signed in as @${result.profile.username}`
                      : 'Signed in'
                  )
                  await onChanged()
                  await refresh()
                })
              }
            >
              Sign in with browser
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !username.trim() || !password}
              onClick={() =>
                void run(async () => {
                  await onApply(['ericServices', 'apiBase'], apiBase.trim())
                  const result = await window.ide.ericServicesLogin({
                    username: username.trim(),
                    password,
                    apiBase: apiBase.trim(),
                    syncAfter: true
                  })
                  if (!result.ok) {
                    setError(result.error || 'Login failed')
                    return
                  }
                  setPassword('')
                  setSyncNotes(result.sync?.changes || [])
                  setMissingKeys(result.sync?.missingKeys || [])
                  const syncNote =
                    result.sync?.ok === false
                      ? ` · sync: ${result.sync.error || 'deferred'}`
                      : result.sync?.direction
                        ? ` · synced (${result.sync.direction})`
                        : ''
                  setMessage(
                    result.profile?.username
                      ? `Signed in as @${result.profile.username}${syncNote}`
                      : `Signed in${syncNote}`
                  )
                  await onChanged()
                  await refresh()
                })
              }
            >
              {needsReauth ? 'Re-authenticate' : 'Sign in & sync'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? 'Hide API base' : 'Advanced'}
            </button>
          </div>
        </section>
      )}

      {linked && (
        <>
          <section className="es-account-section">
            <div className="es-account-section-head">
              <div>
                <h3>Profile sync</h3>
                <p className="es-account-hint">
                  Syncs editor, chat font, updates channel, agent routing &amp; approvals, model
                  connections, embeddings, language servers, evals routing, background agents, MCP
                  configs, GitHub prefs, and user skills. API keys, tokens, secret env values, log
                  paths, and workspace git links stay on this device.
                </p>
              </div>
              <label className="es-toggle">
                <input
                  type="checkbox"
                  checked={syncEnabled}
                  onChange={(e) =>
                    void run(async () => {
                      await onApply(['ericServices', 'syncEnabled'], e.target.checked)
                      await onChanged()
                    })
                  }
                />
                <span>Sync on sign-in</span>
              </label>
            </div>
            <div className="es-sync-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await window.ide.ericServicesSync('bidirectional')
                    if (!result.ok) {
                      setError(result.error || 'Sync failed')
                      return
                    }
                    setSyncNotes(result.changes || [])
                    setMissingKeys(result.missingKeys || [])
                    setMessage(
                      result.changes?.length
                        ? result.changes.join(' · ')
                        : result.direction === 'pull'
                          ? 'Pulled latest profile from EricServic.es'
                          : 'Pushed local profile to EricServic.es'
                    )
                    await onChanged()
                    await refresh()
                  })
                }
              >
                Sync now
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await window.ide.ericServicesSync('pull')
                    if (!result.ok) {
                      setError(result.error || 'Pull failed')
                      return
                    }
                    setMessage(
                      result.updatedAt
                        ? 'Pulled remote profile'
                        : 'Nothing remote yet — push to upload'
                    )
                    await onChanged()
                    await refresh()
                  })
                }
              >
                Pull
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await window.ide.ericServicesSync('push')
                    if (!result.ok) {
                      setError(result.error || 'Push failed')
                      return
                    }
                    setMessage('Pushed local profile')
                    await onChanged()
                    await refresh()
                  })
                }
              >
                Push
              </button>
            </div>
            {syncNotes.length > 0 && (
              <ul className="es-account-hint">
                {syncNotes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {missingKeys.length > 0 && (
              <p className="es-account-hint">
                These connections still need an API key on this device:{' '}
                {missingKeys.map((item) => item.name).join(', ')}.
              </p>
            )}
          </section>

          <section className="es-account-section">
            <h3>Devices</h3>
            <p className="es-account-hint">
              Revoke a device to sign it out. This machine is marked Current.
            </p>
            {devices.length === 0 ? (
              <p className="es-account-hint">No other device list yet. Refresh after the site update is deployed.</p>
            ) : (
              <ul className="es-account-hint">
                {devices.map((device) => (
                  <li key={device.id}>
                    {device.name}
                    {device.prefix ? ` · eseris_${device.prefix}…` : ''}
                    {device.current ? ' · Current' : ''}
                    {device.lastUsedAt ? ` · last used ${formatSyncedAt(device.lastUsedAt)}` : ''}
                    {!device.current && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await window.ide.ericServicesRevokeDevice(device.id)
                              if (!result.ok) {
                                setError(result.error || 'Could not revoke that device')
                                return
                              }
                              setMessage(`Revoked ${device.name}`)
                              await refresh()
                            })
                          }
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="es-account-section es-account-section-muted">
            <h3>Sign out</h3>
            <p className="es-account-hint">
              Revokes this device token. Settings already applied on this machine are kept.
            </p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.ide.ericServicesLogout()
                  setMessage('Signed out')
                  setUsername('')
                  await onChanged()
                  await refresh()
                })
              }
            >
              Sign out
            </button>
          </section>
        </>
      )}

      {(error || message) && (
        <div className={`es-account-toast${error ? ' is-error' : ' is-ok'}`}>
          {error || message}
        </div>
      )}
    </div>
  )
}
