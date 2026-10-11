import { ipcMain, shell } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import { gitStatus } from '../services/git-service'
import {
  buildLinkState,
  cloneUrlHttps,
  cloneUrlSsh,
  createGithubPullRequest,
  createGithubRepository,
  detectGithubFromRemote,
  listGithubPullRequests,
  parseGithubRepo,
  pushPullFetch,
  repoPageUrl,
  setRemoteUrl,
  testGithubToken
} from '../services/github'
import { appState } from '../app-state'
import { getSecret, storeSecret } from './shared'

export function registerGithubIpc(): void {
  ipcMain.handle('github:listPullRequests', async () => {
    if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open', pullRequests: [] }
    const settings = getResolvedSettings(appState.currentWorkspace)
    const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
    const ref = parseGithubRepo(settings.github.repository, settings.github.host)
    if (!token || !ref) {
      return { ok: false, error: 'Link a GitHub repo and add a token first', pullRequests: [] }
    }
    return listGithubPullRequests({
      host: ref.host,
      token,
      owner: ref.owner,
      repo: ref.repo
    })
  })

  ipcMain.handle(
    'github:createPullRequest',
    async (
      _e,
      payload: { title: string; body?: string; head?: string; base?: string; draft?: boolean }
    ) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
      const settings = getResolvedSettings(appState.currentWorkspace)
      const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
      const ref = parseGithubRepo(settings.github.repository, settings.github.host)
      if (!token || !ref) {
        return { ok: false, error: 'Link a GitHub repo and add a token first' }
      }
      const status = await gitStatus(appState.currentWorkspace)
      const head = payload.head || status.branch
      const base = payload.base || settings.github.defaultBranch || 'main'
      if (!head) return { ok: false, error: 'Could not determine current branch' }
      if (!payload.title?.trim()) return { ok: false, error: 'PR title required' }
      return createGithubPullRequest({
        host: ref.host,
        token,
        owner: ref.owner,
        repo: ref.repo,
        title: payload.title.trim(),
        body: payload.body,
        head,
        base,
        draft: payload.draft
      })
    }
  )

  ipcMain.handle('github:status', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    return buildLinkState(appState.currentWorkspace, settings, getSecret)
  })

  ipcMain.handle('github:testToken', async (_e, token?: string) => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const value =
      (typeof token === 'string' && token.trim()) ||
      (settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null)
    if (!value) return { ok: false, error: 'No GitHub token configured' }
    return testGithubToken(settings.github.host, value)
  })

  ipcMain.handle(
    'github:link',
    async (
      _e,
      payload: {
        repository: string
        remoteName?: string
        defaultBranch?: string
        preferredProtocol?: 'https' | 'ssh'
        host?: string
        setGitRemote?: boolean
      }
    ) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'Open a workspace to link GitHub' }
      const settings = getResolvedSettings(appState.currentWorkspace)
      const host = payload.host || settings.github.host
      const ref = parseGithubRepo(payload.repository, host)
      if (!ref) {
        return {
          ok: false,
          error: 'Enter owner/repo or a GitHub URL (e.g. acme/app or https://github.com/acme/app)'
        }
      }
      const remoteName = payload.remoteName || settings.github.remoteName || 'origin'
      const preferredProtocol = payload.preferredProtocol || settings.github.preferredProtocol
      const cloneUrl =
        preferredProtocol === 'ssh' ? cloneUrlSsh(ref) : cloneUrlHttps(ref)

      if (payload.setGitRemote !== false) {
        const remote = await setRemoteUrl(appState.currentWorkspace, remoteName, cloneUrl)
        if (!remote.ok) return remote
      }

      // Host/protocol stay user-scoped; repo link is workspace-scoped
      setSettings(
        'user',
        {
          github: {
            host: ref.host,
            preferredProtocol
          }
        },
        appState.currentWorkspace
      )
      setSettings(
        'workspace',
        {
          github: {
            repository: `${ref.owner}/${ref.repo}`,
            remoteName,
            defaultBranch: payload.defaultBranch || settings.github.defaultBranch || 'main',
            linked: true
          }
        },
        appState.currentWorkspace
      )
      return buildLinkState(appState.currentWorkspace, getResolvedSettings(appState.currentWorkspace), getSecret)
    }
  )

  ipcMain.handle('github:unlink', async () => {
    if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
    setSettings(
      'workspace',
      {
        github: {
          repository: '',
          linked: false
        }
      },
      appState.currentWorkspace
    )
    return buildLinkState(appState.currentWorkspace, getResolvedSettings(appState.currentWorkspace), getSecret)
  })

  ipcMain.handle('github:detectRemote', async () => {
    if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
    const settings = getResolvedSettings(appState.currentWorkspace)
    const ref = await detectGithubFromRemote(
      appState.currentWorkspace,
      settings.github.remoteName || 'origin',
      settings.github.host
    )
    if (!ref) return { ok: false, error: 'No GitHub remote found on origin' }
    return {
      ok: true,
      repository: `${ref.owner}/${ref.repo}`,
      host: ref.host,
      pageUrl: repoPageUrl(ref)
    }
  })

  ipcMain.handle('github:open', async (_e, which?: 'page' | 'issues' | 'prs' | 'actions') => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const state = await buildLinkState(appState.currentWorkspace, settings, getSecret)
    if (!state.pageUrl) return { ok: false, error: 'No linked GitHub repository' }
    const suffix =
      which === 'issues'
        ? '/issues'
        : which === 'prs'
          ? '/pulls'
          : which === 'actions'
            ? '/actions'
            : ''
    await shell.openExternal(`${state.pageUrl}${suffix}`)
    return { ok: true, url: `${state.pageUrl}${suffix}` }
  })

  ipcMain.handle(
    'github:sync',
    async (_e, action: 'fetch' | 'pull' | 'push') => {
      if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
      const settings = getResolvedSettings(appState.currentWorkspace)
      const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
      const ref = settings.github.repository
        ? parseGithubRepo(settings.github.repository, settings.github.host)
        : await detectGithubFromRemote(
            appState.currentWorkspace,
            settings.github.remoteName || 'origin',
            settings.github.host
          )
      const branchRes = await gitStatus(appState.currentWorkspace)
      return pushPullFetch(
        appState.currentWorkspace,
        action,
        settings.github.remoteName || 'origin',
        branchRes.branch,
        token,
        ref,
        settings.github.preferredProtocol
      )
    }
  )

  ipcMain.handle(
    'github:createRepo',
    async (
      _e,
      payload: {
        name: string
        description?: string
        privateRepo?: boolean
        autoInit?: boolean
        link?: boolean
      }
    ) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'Open a workspace first' }
      const settings = getResolvedSettings(appState.currentWorkspace)
      const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
      if (!token) return { ok: false, error: 'Add a GitHub personal access token first' }
      const created = await createGithubRepository({
        host: settings.github.host,
        token,
        name: payload.name,
        description: payload.description,
        privateRepo: payload.privateRepo,
        autoInit: payload.autoInit
      })
      if (!created.ok || !created.fullName) return created
      if (payload.link !== false) {
        const ref = parseGithubRepo(created.fullName, settings.github.host)!
        const url =
          settings.github.preferredProtocol === 'ssh'
            ? cloneUrlSsh(ref)
            : cloneUrlHttps(ref)
        await setRemoteUrl(appState.currentWorkspace, settings.github.remoteName || 'origin', url)
        setSettings(
          'workspace',
          {
            github: {
              repository: created.fullName,
              linked: true,
              remoteName: settings.github.remoteName || 'origin',
              defaultBranch: settings.github.defaultBranch || 'main'
            }
          },
          appState.currentWorkspace
        )
      }
      return {
        ...created,
        link: await buildLinkState(
          appState.currentWorkspace,
          getResolvedSettings(appState.currentWorkspace),
          getSecret
        )
      }
    }
  )

  ipcMain.handle('github:setToken', async (_e, token: string) => {
    const ref = 'github.pat'
    if (!token.trim()) {
      setSettings('user', { github: { tokenRef: '' } }, appState.currentWorkspace)
      return { ok: true, cleared: true }
    }
    storeSecret(ref, token.trim())
    setSettings('user', { github: { tokenRef: ref } }, appState.currentWorkspace)
    const checked = await testGithubToken(
      getResolvedSettings(appState.currentWorkspace).github.host,
      token.trim()
    )
    return { ok: checked.ok, login: checked.login, error: checked.error, cleared: false }
  })
}
