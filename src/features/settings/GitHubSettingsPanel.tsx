import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, SettingsScope } from '@/shared/settings-schema'

type GithubStatus = Awaited<ReturnType<typeof window.ide.githubStatus>>

interface Props {
  resolved: AppSettings
  hasWorkspace: boolean
  scope: SettingsScope
  onScopeChange: (scope: SettingsScope) => void
  onApply: (path: string[], value: unknown) => Promise<void>
  onChanged: () => Promise<void>
}

export function GitHubSettingsPanel({
  resolved,
  hasWorkspace,
  scope,
  onScopeChange,
  onApply,
  onChanged
}: Props) {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [token, setToken] = useState('')
  const [repository, setRepository] = useState(resolved.github.repository || '')
  const [host, setHost] = useState(resolved.github.host || 'github.com')
  const [remoteName, setRemoteName] = useState(resolved.github.remoteName || 'origin')
  const [defaultBranch, setDefaultBranch] = useState(resolved.github.defaultBranch || 'main')
  const [protocol, setProtocol] = useState<'https' | 'ssh'>(
    resolved.github.preferredProtocol || 'https'
  )
  const [newRepoName, setNewRepoName] = useState('')
  const [newRepoPrivate, setNewRepoPrivate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await window.ide.githubStatus()
      setStatus(s)
      if (s.repository) setRepository(s.repository)
      if (s.host) setHost(s.host)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GitHub status')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, resolved.github.repository, resolved.github.linked])

  useEffect(() => {
    setRepository(resolved.github.repository || '')
    setHost(resolved.github.host || 'github.com')
    setRemoteName(resolved.github.remoteName || 'origin')
    setDefaultBranch(resolved.github.defaultBranch || 'main')
    setProtocol(resolved.github.preferredProtocol || 'https')
  }, [resolved.github])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="github-settings">
      <p className="subtitle" style={{ marginTop: 0 }}>
        Link this project to a GitHub repository. Account token is stored securely (user settings);
        the repo link is saved in the workspace (<code>.eris/settings.json</code>).
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select
          className="scope-select"
          value={scope}
          onChange={(e) => onScopeChange(e.target.value as SettingsScope)}
        >
          <option value="user">User (token / host)</option>
          <option value="workspace" disabled={!hasWorkspace}>
            Workspace (repo link)
          </option>
        </select>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {status && (
        <div className="github-status-card">
          <div className="model-conn-row-head">
            <span className={`status-dot ${status.linked || status.pageUrl ? 'ok' : ''}`} />
            <strong>{status.linked ? 'Linked' : status.repository ? 'Detected' : 'Not linked'}</strong>
            {status.apiUser && <span className="badge">@{status.apiUser}</span>}
            {status.hasToken ? (
              <span className="badge">token</span>
            ) : (
              <span className="badge">no token</span>
            )}
            {status.branch && <span className="badge">⎇ {status.branch}</span>}
          </div>
          {status.pageUrl ? (
            <div className="model-conn-meta">
              <a
                href={status.pageUrl}
                onClick={(e) => {
                  e.preventDefault()
                  void window.ide.githubOpen('page')
                }}
              >
                {status.pageUrl}
              </a>
              {status.remoteUrl ? ` · remote ${status.remoteUrl}` : ''}
            </div>
          ) : (
            <div className="model-conn-meta">No GitHub page linked yet.</div>
          )}
          <div className="model-conn-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !status.pageUrl}
              onClick={() => void window.ide.githubOpen('page')}
            >
              Open repo
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !status.pageUrl}
              onClick={() => void window.ide.githubOpen('issues')}
            >
              Issues
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !status.pageUrl}
              onClick={() => void window.ide.githubOpen('prs')}
            >
              Pull requests
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !status.pageUrl}
              onClick={() => void window.ide.githubOpen('actions')}
            >
              Actions
            </button>
          </div>
        </div>
      )}

      <section className="github-section">
        <h3>Account</h3>
        <p className="model-conn-hint">
          Create a classic PAT with <code>repo</code> scope at github.com/settings/tokens (or a fine-grained
          token with Contents + Metadata). Used for push/pull and creating repos.
        </p>
        <label className="field">
          <span>GitHub host</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="github.com"
          />
        </label>
        <label className="field">
          <span>Personal access token {status?.hasToken ? '· saved' : ''}</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={status?.hasToken ? '•••••••• (paste to replace)' : 'ghp_…'}
            autoComplete="off"
          />
        </label>
        <div className="model-conn-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !token.trim()}
            onClick={() =>
              void run(async () => {
                await onApply(['github', 'host'], host.trim() || 'github.com')
                const result = await window.ide.githubSetToken(token.trim())
                if (!result.ok) {
                  setError(result.error || 'Token rejected')
                  return
                }
                setToken('')
                setMessage(result.login ? `Signed in as @${result.login}` : 'Token saved')
                await onChanged()
                await refresh()
              })
            }
          >
            Save &amp; verify token
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await onApply(['github', 'host'], host.trim() || 'github.com')
                const result = await window.ide.githubTestToken()
                if (!result.ok) setError(result.error || 'Token check failed')
                else setMessage(result.login ? `Token OK · @${result.login}` : 'Token OK')
              })
            }
          >
            Test saved token
          </button>
          {status?.hasToken && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.ide.githubSetToken('')
                  setMessage('Token cleared')
                  await onChanged()
                  await refresh()
                })
              }
            >
              Clear token
            </button>
          )}
        </div>
      </section>

      <section className="github-section">
        <h3>Link project</h3>
        {!hasWorkspace && (
          <p className="model-conn-hint">Open a workspace folder to link it to a GitHub page.</p>
        )}
        <label className="field">
          <span>Repository (owner/repo or URL)</span>
          <input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="acme/my-app or https://github.com/acme/my-app"
            disabled={!hasWorkspace}
          />
        </label>
        <div className="github-inline-fields">
          <label className="field">
            <span>Remote name</span>
            <input
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
              disabled={!hasWorkspace}
            />
          </label>
          <label className="field">
            <span>Default branch</span>
            <input
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!hasWorkspace}
            />
          </label>
          <label className="field">
            <span>Protocol</span>
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as 'https' | 'ssh')}
              disabled={!hasWorkspace}
            >
              <option value="https">HTTPS</option>
              <option value="ssh">SSH</option>
            </select>
          </label>
        </div>
        <div className="model-conn-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !hasWorkspace || !repository.trim()}
            onClick={() =>
              void run(async () => {
                const result = (await window.ide.githubLink({
                  repository: repository.trim(),
                  remoteName: remoteName.trim() || 'origin',
                  defaultBranch: defaultBranch.trim() || 'main',
                  preferredProtocol: protocol,
                  host: host.trim() || 'github.com',
                  setGitRemote: true
                })) as GithubStatus & { ok?: boolean; error?: string }
                if (result.error && result.ok === false) {
                  setError(String(result.error))
                  return
                }
                setMessage(`Linked to ${result.repository || repository}`)
                await onChanged()
                await refresh()
              })
            }
          >
            Link &amp; set git remote
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !hasWorkspace}
            onClick={() =>
              void run(async () => {
                const detected = await window.ide.githubDetectRemote()
                if (!detected.ok || !detected.repository) {
                  setError(detected.error || 'No remote found')
                  return
                }
                setRepository(detected.repository)
                if (detected.host) setHost(detected.host)
                const result = (await window.ide.githubLink({
                  repository: detected.repository,
                  remoteName: remoteName.trim() || 'origin',
                  defaultBranch: defaultBranch.trim() || 'main',
                  preferredProtocol: protocol,
                  host: detected.host || host,
                  setGitRemote: false
                })) as GithubStatus & { ok?: boolean; error?: string }
                if (result.error && result.ok === false) {
                  setError(String(result.error))
                  return
                }
                setMessage(`Linked from existing remote · ${detected.repository}`)
                await onChanged()
                await refresh()
              })
            }
          >
            Detect from origin
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !hasWorkspace || !status?.linked}
            onClick={() =>
              void run(async () => {
                await window.ide.githubUnlink()
                setMessage('Unlinked (git remote left unchanged)')
                await onChanged()
                await refresh()
              })
            }
          >
            Unlink
          </button>
        </div>
      </section>

      <section className="github-section">
        <h3>Sync</h3>
        <div className="model-conn-actions">
          {(['fetch', 'pull', 'push'] as const).map((action) => (
            <button
              key={action}
              type="button"
              className="btn"
              disabled={busy || !hasWorkspace}
              onClick={() =>
                void run(async () => {
                  const result = await window.ide.githubSync(action)
                  if (!result.ok) setError(result.error || `${action} failed`)
                  else setMessage(result.output || `${action} complete`)
                  await refresh()
                })
              }
            >
              {action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull' : 'Push'}
            </button>
          ))}
        </div>
      </section>

      <section className="github-section">
        <h3>Create repository on GitHub</h3>
        <p className="model-conn-hint">
          Creates a new repo under your account, sets <code>origin</code>, and links this project.
        </p>
        <label className="field">
          <span>New repo name</span>
          <input
            value={newRepoName}
            onChange={(e) => setNewRepoName(e.target.value)}
            placeholder="my-project"
            disabled={!hasWorkspace}
          />
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={newRepoPrivate}
            onChange={(e) => setNewRepoPrivate(e.target.checked)}
            disabled={!hasWorkspace}
          />
          <span>Private repository</span>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !hasWorkspace || !newRepoName.trim() || !status?.hasToken}
          onClick={() =>
            void run(async () => {
              const result = await window.ide.githubCreateRepo({
                name: newRepoName.trim(),
                privateRepo: newRepoPrivate,
                autoInit: false,
                link: true
              })
              if (!result.ok) {
                setError(result.error || 'Create failed')
                return
              }
              setMessage(`Created ${result.fullName}`)
              if (result.htmlUrl) {
                // leave browser open optional — user can use Open repo
              }
              setNewRepoName('')
              await onChanged()
              await refresh()
            })
          }
        >
          Create &amp; link
        </button>
      </section>

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
