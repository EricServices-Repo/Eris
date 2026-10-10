import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, SettingsScope } from '@/shared/settings-schema'

type AccountStatus = Awaited<ReturnType<typeof window.ide.ericServicesStatus>>

interface Props {
  resolved: AppSettings
  scope: SettingsScope
  onScopeChange: (scope: SettingsScope) => void
  onApply: (path: string[], value: unknown) => Promise<void>
  onChanged: () => Promise<void>
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

  const refresh = useCallback(async () => {
    try {
      const s = await window.ide.ericServicesStatus()
      setStatus(s)
      if (s.apiBase) setApiBase(s.apiBase)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account status')
    }
  }, [])

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

  const linked = Boolean(status?.linked && status?.hasToken)

  return (
    <div className="github-settings">
      <p className="subtitle" style={{ marginTop: 0 }}>
        Sign in with your{' '}
        <a
          href="https://www.ericservic.es/loginform.php"
          onClick={(e) => {
            e.preventDefault()
            void window.ide.ericServicesOpenAccount()
          }}
        >
          EricServic.es
        </a>{' '}
        Control Hub account to link this Eris profile and sync editor, agent, and model preferences
        across machines. Tokens are stored securely in user settings.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select
          className="scope-select"
          value={scope}
          onChange={(e) => onScopeChange(e.target.value as SettingsScope)}
        >
          <option value="user">User (account / sync)</option>
          <option value="workspace" disabled>
            Workspace (not used)
          </option>
        </select>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {status && (
        <div className="github-status-card">
          <div className="model-conn-row-head">
            <span className={`status-dot ${linked ? 'ok' : ''}`} />
            <strong>{linked ? 'Linked' : 'Not signed in'}</strong>
            {status.username && <span className="badge">@{status.username}</span>}
            {status.hasToken ? (
              <span className="badge">token</span>
            ) : (
              <span className="badge">no token</span>
            )}
          </div>
          {status.email && <div className="model-conn-meta">{status.email}</div>}
          {status.lastSyncedAt && (
            <div className="model-conn-meta">Last synced · {status.lastSyncedAt}</div>
          )}
          {status.error && (
            <div className="subtitle" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {status.error}
            </div>
          )}
          <div className="model-conn-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void window.ide.ericServicesOpenAccount()}
            >
              Open account
            </button>
          </div>
        </div>
      )}

      {!linked && (
        <section className="github-section">
          <h3>Sign in</h3>
          <p className="model-conn-hint">
            Use the same username and password as{' '}
            <code>www.ericservic.es/loginform.php</code>. A device token is issued for Eris (password
            is not stored).
          </p>
          <label className="field">
            <span>API base</span>
            <input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder="https://www.ericservic.es"
            />
          </label>
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
          <div className="model-conn-actions">
            <button
              type="button"
              className="btn btn-primary"
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
                  const syncNote =
                    result.sync?.ok === false
                      ? ` · sync note: ${result.sync.error || 'deferred'}`
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
              Sign in &amp; sync
            </button>
          </div>
        </section>
      )}

      {linked && (
        <>
          <section className="github-section">
            <h3>Profile sync</h3>
            <p className="model-conn-hint">
              Syncs editor prefs, agent routing, model connections (URLs/models only), MCP server
              configs, GitHub host/protocol, and your user skills. API keys, tokens, MCP env secret
              values, and machine paths stay local.
            </p>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={resolved.ericServices?.syncEnabled !== false}
                onChange={(e) =>
                  void run(async () => {
                    await onApply(['ericServices', 'syncEnabled'], e.target.checked)
                    await onChanged()
                  })
                }
              />
              <span>Enable sync on sign-in</span>
            </label>
            <div className="model-conn-actions">
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
                    setMessage(
                      result.direction === 'pull'
                        ? 'Pulled profile settings from EricServic.es'
                        : 'Pushed profile settings to EricServic.es'
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
                        ? 'Pulled remote profile settings'
                        : 'No remote settings yet — use Push to upload'
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
                    setMessage('Pushed local profile settings')
                    await onChanged()
                    await refresh()
                  })
                }
              >
                Push
              </button>
            </div>
          </section>

          <section className="github-section">
            <h3>Sign out</h3>
            <p className="model-conn-hint">
              Revokes this device token on EricServic.es and clears the local link. Synced settings
              already applied stay on this machine.
            </p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.ide.ericServicesLogout()
                  setMessage('Signed out')
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

      {error && (
        <div className="subtitle" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      {message && !error && (
        <div className="subtitle" style={{ color: 'var(--success, #3d9a5f)' }}>
          {message}
        </div>
      )}
    </div>
  )
}
