import { useCallback, useEffect, useState } from 'react'

export interface GitStatusEntry {
  path: string
  index: string
  worktree: string
  status: string
}

export interface GitStatusResult {
  ok: boolean
  error?: string
  branch: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
}

type GithubStatus = Awaited<ReturnType<typeof window.ide.githubStatus>>

interface Props {
  open: boolean
  workspacePath: string | null
  onClose: () => void
  onOpenPath: (path: string) => void
  onOpenGithubSettings?: () => void
}

export function GitPanel({
  open,
  workspacePath,
  onClose,
  onOpenPath,
  onOpenGithubSettings
}: Props) {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [github, setGithub] = useState<GithubStatus | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [newRepoName, setNewRepoName] = useState('')
  const [newRepoPrivate, setNewRepoPrivate] = useState(true)
  const [branches, setBranches] = useState<string[]>([])
  const [branchSelect, setBranchSelect] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [prTitle, setPrTitle] = useState('')
  const [pullRequests, setPullRequests] = useState<
    Array<{ number: number; title: string; htmlUrl: string; head: string; base: string }>
  >([])

  const refresh = useCallback(async () => {
    if (!workspacePath) return
    setBusy(true)
    setError(null)
    try {
      const [s, gh, br] = await Promise.all([
        window.ide.gitStatus(),
        window.ide.githubStatus(),
        window.ide.gitBranches()
      ])
      setStatus(s)
      setGithub(gh)
      if (gh.repository) setRepoInput(gh.repository)
      if (br.ok) {
        setBranches(br.branches)
        setBranchSelect(br.current || '')
      }
      if (!s.ok) setError(s.error || 'Git unavailable')
      const d = await window.ide.gitDiff()
      setDiff(d.ok ? d.diff : d.error || '')
      if (gh.linked && gh.hasToken) {
        const prs = await window.ide.githubListPullRequests()
        if (prs.ok) setPullRequests(prs.pullRequests)
      } else {
        setPullRequests([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Git failed')
    } finally {
      setBusy(false)
    }
  }, [workspacePath])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (open && github && !github.linked && !github.pageUrl) {
      setShowLinkForm(true)
    }
  }, [open, github])

  const linkRepo = async (repository: string, setGitRemote = true) => {
    const result = (await window.ide.githubLink({
      repository: repository.trim(),
      setGitRemote
    })) as GithubStatus & { ok?: boolean; error?: string }
    if (result.error && result.ok === false) {
      setError(String(result.error))
      return false
    }
    setInfo(`Linked to ${result.repository || repository}`)
    setShowLinkForm(false)
    await refresh()
    return true
  }

  if (!open) return null

  const linked = Boolean(github?.linked || github?.pageUrl)

  return (
    <div className="git-panel">
      <div className="terminal-bar">
        <strong>Source Control</strong>
        <span className="thinking-status-inline">
          {status?.branch ? `⎇ ${status.branch}` : '—'}
          {status && status.ahead ? ` ↑${status.ahead}` : ''}
          {status && status.behind ? ` ↓${status.behind}` : ''}
        </span>
        <div className="diff-actions">
          <button type="button" className="btn" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Editor
          </button>
        </div>
      </div>

      <div className="github-git-bar">
        {linked ? (
          <>
            <button
              type="button"
              className="btn"
              title={github?.pageUrl || ''}
              disabled={busy}
              onClick={() => void window.ide.githubOpen('page')}
            >
              {github?.repository || 'GitHub'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setInfo(null)
                  setError(null)
                  const r = await window.ide.githubSync('pull')
                  if (!r.ok) setError(r.error || 'Pull failed')
                  else setInfo(r.output || 'Pulled')
                  await refresh()
                  setBusy(false)
                })()
              }
            >
              Pull
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setInfo(null)
                  setError(null)
                  const r = await window.ide.githubSync('push')
                  if (!r.ok) setError(r.error || 'Push failed')
                  else setInfo(r.output || 'Pushed')
                  await refresh()
                  setBusy(false)
                })()
              }
            >
              Push
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setShowLinkForm((v) => !v)}
            >
              {showLinkForm ? 'Hide link' : 'Change link'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowLinkForm((v) => !v)}
          >
            {showLinkForm ? 'Hide' : 'Link GitHub repo…'}
          </button>
        )}
        {onOpenGithubSettings && (
          <button type="button" className="btn" onClick={() => onOpenGithubSettings()}>
            GitHub settings
          </button>
        )}
      </div>

      {showLinkForm && (
        <div className="github-link-inline">
          <p className="model-conn-hint" style={{ marginTop: 0 }}>
            Link this workspace to a GitHub repository. Saves to{' '}
            <code>.eris/settings.json</code> and sets the git remote (runs{' '}
            <code>git init</code> if needed).
          </p>
          {!github?.hasToken && (
            <p className="model-conn-hint">
              Optional: add a personal access token in{' '}
              <button
                type="button"
                className="linkish"
                onClick={() => onOpenGithubSettings?.()}
              >
                GitHub settings
              </button>{' '}
              for push/pull and creating repos.
            </p>
          )}
          <label className="field">
            <span>Repository (owner/repo or URL)</span>
            <input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="acme/my-app or https://github.com/acme/my-app"
              disabled={busy || !workspacePath}
            />
          </label>
          <div className="model-conn-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !workspacePath || !repoInput.trim()}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setError(null)
                  setInfo(null)
                  try {
                    await linkRepo(repoInput)
                  } finally {
                    setBusy(false)
                  }
                })()
              }
            >
              Link &amp; set remote
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !workspacePath}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setError(null)
                  setInfo(null)
                  try {
                    const detected = await window.ide.githubDetectRemote()
                    if (!detected.ok || !detected.repository) {
                      setError(detected.error || 'No GitHub remote on origin')
                      return
                    }
                    setRepoInput(detected.repository)
                    await linkRepo(detected.repository, false)
                  } finally {
                    setBusy(false)
                  }
                })()
              }
            >
              Detect from origin
            </button>
            {linked && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true)
                    setError(null)
                    await window.ide.githubUnlink()
                    setInfo('Unlinked (git remote left unchanged)')
                    setShowLinkForm(true)
                    await refresh()
                    setBusy(false)
                  })()
                }
              >
                Unlink
              </button>
            )}
          </div>

          <div className="github-create-inline">
            <label className="field">
              <span>Or create a new repo on GitHub</span>
              <input
                value={newRepoName}
                onChange={(e) => setNewRepoName(e.target.value)}
                placeholder="my-project"
                disabled={busy || !workspacePath || !github?.hasToken}
              />
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={newRepoPrivate}
                onChange={(e) => setNewRepoPrivate(e.target.checked)}
                disabled={busy || !github?.hasToken}
              />
              <span>Private</span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !workspacePath || !newRepoName.trim() || !github?.hasToken}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setError(null)
                  setInfo(null)
                  try {
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
                    setInfo(`Created & linked ${result.fullName}`)
                    setNewRepoName('')
                    setShowLinkForm(false)
                    await refresh()
                  } finally {
                    setBusy(false)
                  }
                })()
              }
            >
              Create &amp; link
            </button>
          </div>
        </div>
      )}

      {status?.ok && (
        <div className="github-link-inline" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="model-conn-actions" style={{ alignItems: 'center' }}>
            <label className="field" style={{ flex: '1 1 140px', margin: 0 }}>
              <span>Branch</span>
              <select
                value={branchSelect}
                disabled={busy || branches.length === 0}
                onChange={(e) => setBranchSelect(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy || !branchSelect || branchSelect === status.branch}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setError(null)
                  const r = await window.ide.gitCheckout({ branch: branchSelect })
                  if (!r.ok) setError(r.error || 'Checkout failed')
                  else setInfo(`Checked out ${branchSelect}`)
                  await refresh()
                  setBusy(false)
                })()
              }
            >
              Switch
            </button>
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="new-branch"
              disabled={busy}
              style={{ flex: '1 1 120px' }}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || !newBranchName.trim()}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setError(null)
                  const r = await window.ide.gitCheckout({
                    branch: newBranchName.trim(),
                    create: true
                  })
                  if (!r.ok) setError(r.error || 'Create branch failed')
                  else {
                    setInfo(`Created ${newBranchName.trim()}`)
                    setNewBranchName('')
                  }
                  await refresh()
                  setBusy(false)
                })()
              }
            >
              Create
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true)
                  setError(null)
                  const r = await window.ide.gitStash({ action: 'push' })
                  if (!r.ok) setError(r.error || 'Stash failed')
                  else setInfo(r.output || 'Stashed')
                  await refresh()
                  setBusy(false)
                })()
              }
            >
              Stash
            </button>
          </div>
          {linked && github?.hasToken && (
            <div className="model-conn-actions" style={{ marginTop: 8 }}>
              <input
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="Pull request title"
                disabled={busy}
                style={{ flex: '1 1 200px' }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !prTitle.trim()}
                onClick={() =>
                  void (async () => {
                    setBusy(true)
                    setError(null)
                    const r = await window.ide.githubCreatePullRequest({
                      title: prTitle.trim()
                    })
                    if (!r.ok) setError(r.error || 'Create PR failed')
                    else {
                      setInfo(r.htmlUrl ? `PR #${r.number}: ${r.htmlUrl}` : `PR #${r.number} created`)
                      setPrTitle('')
                      if (r.htmlUrl) void window.ide.githubOpen('prs')
                    }
                    await refresh()
                    setBusy(false)
                  })()
                }
              >
                Create PR
              </button>
            </div>
          )}
          {pullRequests.length > 0 && (
            <div className="project-menu-items" style={{ marginTop: 6 }}>
              {pullRequests.slice(0, 5).map((pr) => (
                <button
                  key={pr.number}
                  type="button"
                  className="project-menu-item"
                  title={pr.htmlUrl}
                  onClick={() => void window.ide.githubOpen('prs')}
                >
                  #{pr.number} {pr.title} ({pr.head} → {pr.base})
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="git-error">{error}</div>}
      {info && !error && <div className="git-info">{info}</div>}
      <div className="git-body">
        <div className="git-files">
          {(status?.entries || []).length === 0 ? (
            <div className="chat-empty">No changes</div>
          ) : (
            status!.entries.map((e) => (
              <button
                key={e.path}
                type="button"
                className="git-file"
                onClick={() => onOpenPath(e.path)}
              >
                <span className="diff-op">{e.status}</span>
                <span>{e.path}</span>
              </button>
            ))
          )}
        </div>
        <pre className="git-diff">{diff || '(select refresh)'}</pre>
      </div>
      <form
        className="git-commit-row"
        onSubmit={(e) => {
          e.preventDefault()
          void (async () => {
            if (!message.trim() || !status?.entries.length) return
            setBusy(true)
            try {
              const paths = status.entries.map((x) => x.path)
              const staged = await window.ide.gitStage(paths)
              if (!staged.ok) {
                setError(staged.error || 'Stage failed')
                return
              }
              const committed = await window.ide.gitCommit(message.trim())
              if (!committed.ok) {
                setError(committed.error || 'Commit failed')
                return
              }
              setMessage('')
              await refresh()
            } finally {
              setBusy(false)
            }
          })()
        }}
      >
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          disabled={busy}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !message.trim() || !status?.entries.length}
        >
          Commit all
        </button>
      </form>
    </div>
  )
}
