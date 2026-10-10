import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../../../src/shared/settings-schema'

export type GithubRepoRef = {
  host: string
  owner: string
  repo: string
}

export type GithubLinkState = {
  ok: boolean
  error?: string
  linked: boolean
  host: string
  repository: string
  remoteName: string
  defaultBranch: string
  preferredProtocol: 'https' | 'ssh'
  hasToken: boolean
  remoteUrl: string | null
  pageUrl: string | null
  cloneUrlHttps: string | null
  cloneUrlSsh: string | null
  isGitRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  apiUser?: string | null
}

function runGit(
  workspacePath: string,
  args: string[],
  envExtra?: Record<string, string>,
  timeoutMs = 60_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: workspacePath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...envExtra }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout: '', stderr: err.message })
    })
  })
}

export function normalizeHost(host: string): string {
  return (host || 'github.com').replace(/^https?:\/\//, '').replace(/\/$/, '') || 'github.com'
}

export function apiBase(host: string): string {
  const h = normalizeHost(host)
  return h === 'github.com' ? 'https://api.github.com' : `https://${h}/api/v3`
}

export function webBase(host: string): string {
  return `https://${normalizeHost(host)}`
}

/** Parse owner/repo, https URL, or git@ SSH URL. */
export function parseGithubRepo(
  input: string,
  defaultHost = 'github.com'
): GithubRepoRef | null {
  const raw = input.trim()
  if (!raw) return null

  // owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    return { host: normalizeHost(defaultHost), owner: raw.split('/')[0]!, repo: raw.split('/')[1]! }
  }

  // git@host:owner/repo.git
  const ssh = raw.match(/^git@([^:]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  if (ssh) {
    return { host: normalizeHost(ssh[1]!), owner: ssh[2]!, repo: ssh[3]! }
  }

  try {
    const withProto = raw.startsWith('http') ? raw : `https://${raw}`
    const url = new URL(withProto)
    const host = normalizeHost(url.host)
    const parts = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { host, owner: parts[0], repo: parts[1] }
    }
  } catch {
    // ignore
  }
  return null
}

export function repoPageUrl(ref: GithubRepoRef): string {
  return `${webBase(ref.host)}/${ref.owner}/${ref.repo}`
}

export function cloneUrlHttps(ref: GithubRepoRef): string {
  return `${webBase(ref.host)}/${ref.owner}/${ref.repo}.git`
}

export function cloneUrlSsh(ref: GithubRepoRef): string {
  return `git@${normalizeHost(ref.host)}:${ref.owner}/${ref.repo}.git`
}

export function authenticatedHttpsUrl(ref: GithubRepoRef, token: string): string {
  const host = normalizeHost(ref.host)
  return `https://x-access-token:${encodeURIComponent(token)}@${host}/${ref.owner}/${ref.repo}.git`
}

async function githubApi(
  host: string,
  token: string | null,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Eris-IDE',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init?.headers as Record<string, string> | undefined)
  }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const res = await fetch(`${apiBase(host)}${path}`, { ...init, headers })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { message: text }
    }
    if (!res.ok) {
      const message =
        typeof json === 'object' && json && 'message' in json
          ? String((json as { message: string }).message)
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, json, error: message }
    }
    return { ok: true, status: res.status, json }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function getRemoteUrl(
  workspacePath: string,
  remoteName: string
): Promise<string | null> {
  const res = await runGit(workspacePath, ['remote', 'get-url', remoteName])
  if (res.code !== 0) return null
  return res.stdout.trim() || null
}

export async function setRemoteUrl(
  workspacePath: string,
  remoteName: string,
  url: string
): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(join(workspacePath, '.git'))) {
    const init = await runGit(workspacePath, ['init'])
    if (init.code !== 0) {
      return { ok: false, error: init.stderr.trim() || 'git init failed' }
    }
  }
  const existing = await getRemoteUrl(workspacePath, remoteName)
  const args = existing
    ? ['remote', 'set-url', remoteName, url]
    : ['remote', 'add', remoteName, url]
  const res = await runGit(workspacePath, args)
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'Failed to set remote' }
  return { ok: true }
}

export async function detectGithubFromRemote(
  workspacePath: string,
  remoteName: string,
  defaultHost: string
): Promise<GithubRepoRef | null> {
  const url = await getRemoteUrl(workspacePath, remoteName)
  if (!url) return null
  return parseGithubRepo(url, defaultHost)
}

export async function buildLinkState(
  workspacePath: string | null,
  settings: AppSettings,
  getSecret: (key: string) => string | null
): Promise<GithubLinkState> {
  const host = normalizeHost(settings.github.host)
  const remoteName = settings.github.remoteName || 'origin'
  const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
  const hasToken = Boolean(token)

  let repository = settings.github.repository.trim()
  let remoteUrl: string | null = null
  let isGitRepo = false
  let branch: string | null = null
  let ahead = 0
  let behind = 0

  if (workspacePath && existsSync(join(workspacePath, '.git'))) {
    isGitRepo = true
    remoteUrl = await getRemoteUrl(workspacePath, remoteName)
    if (!repository && remoteUrl) {
      const detected = parseGithubRepo(remoteUrl, host)
      if (detected) repository = `${detected.owner}/${detected.repo}`
    }
    const branchRes = await runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchRes.code === 0) branch = branchRes.stdout.trim()
    const statusRes = await runGit(workspacePath, ['status', '-sb'])
    if (statusRes.code === 0) {
      const m = statusRes.stdout.match(/\[ahead\s+(\d+)|behind\s+(\d+)/g)
      // parse from porcelain -b style first line
      const line = statusRes.stdout.split('\n')[0] || ''
      const aheadM = line.match(/ahead\s+(\d+)/)
      const behindM = line.match(/behind\s+(\d+)/)
      ahead = aheadM ? Number(aheadM[1]) : 0
      behind = behindM ? Number(behindM[1]) : 0
      void m
    }
  }

  const ref = repository ? parseGithubRepo(repository, host) : null
  const pageUrl = ref ? repoPageUrl(ref) : null

  let apiUser: string | null = null
  if (token) {
    const me = await githubApi(host, token, '/user')
    if (me.ok && me.json && typeof me.json === 'object' && 'login' in me.json) {
      apiUser = String((me.json as { login: string }).login)
    }
  }

  return {
    ok: true,
    linked: Boolean(settings.github.linked && repository),
    host: ref?.host || host,
    repository: repository || '',
    remoteName,
    defaultBranch: settings.github.defaultBranch || 'main',
    preferredProtocol: settings.github.preferredProtocol,
    hasToken,
    remoteUrl,
    pageUrl,
    cloneUrlHttps: ref ? cloneUrlHttps(ref) : null,
    cloneUrlSsh: ref ? cloneUrlSsh(ref) : null,
    isGitRepo,
    branch,
    ahead,
    behind,
    apiUser
  }
}

export async function testGithubToken(
  host: string,
  token: string
): Promise<{ ok: boolean; login?: string; error?: string }> {
  const res = await githubApi(host, token, '/user')
  if (!res.ok) return { ok: false, error: res.error || 'Token check failed' }
  const login =
    res.json && typeof res.json === 'object' && 'login' in res.json
      ? String((res.json as { login: string }).login)
      : undefined
  return { ok: true, login }
}

export async function listGithubPullRequests(options: {
  host: string
  token: string
  owner: string
  repo: string
  state?: 'open' | 'closed' | 'all'
}): Promise<{
  ok: boolean
  error?: string
  pullRequests: Array<{
    number: number
    title: string
    htmlUrl: string
    state: string
    head: string
    base: string
  }>
}> {
  const state = options.state || 'open'
  const res = await githubApi(
    options.host,
    options.token,
    `/repos/${options.owner}/${options.repo}/pulls?state=${state}&per_page=30`
  )
  if (!res.ok) return { ok: false, error: res.error || 'List PRs failed', pullRequests: [] }
  const arr = Array.isArray(res.json) ? res.json : []
  return {
    ok: true,
    pullRequests: arr.map((p: Record<string, unknown>) => ({
      number: Number(p.number),
      title: String(p.title || ''),
      htmlUrl: String(p.html_url || ''),
      state: String(p.state || ''),
      head: String((p.head as { ref?: string } | undefined)?.ref || ''),
      base: String((p.base as { ref?: string } | undefined)?.ref || '')
    }))
  }
}

export async function createGithubPullRequest(options: {
  host: string
  token: string
  owner: string
  repo: string
  title: string
  body?: string
  head: string
  base: string
  draft?: boolean
}): Promise<{
  ok: boolean
  error?: string
  number?: number
  htmlUrl?: string
}> {
  const res = await githubApi(
    options.host,
    options.token,
    `/repos/${options.owner}/${options.repo}/pulls`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: options.title,
        body: options.body || '',
        head: options.head,
        base: options.base,
        draft: Boolean(options.draft)
      })
    }
  )
  if (!res.ok) return { ok: false, error: res.error || 'Create PR failed' }
  const json = res.json as { number?: number; html_url?: string }
  return { ok: true, number: json.number, htmlUrl: json.html_url }
}

export async function createGithubRepository(options: {
  host: string
  token: string
  name: string
  description?: string
  privateRepo?: boolean
  autoInit?: boolean
}): Promise<{ ok: boolean; fullName?: string; htmlUrl?: string; cloneUrl?: string; error?: string }> {
  const res = await githubApi(options.host, options.token, '/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: options.name,
      description: options.description || '',
      private: Boolean(options.privateRepo),
      auto_init: Boolean(options.autoInit)
    })
  })
  if (!res.ok) return { ok: false, error: res.error || 'Create repo failed' }
  const json = res.json as {
    full_name?: string
    html_url?: string
    clone_url?: string
  }
  return {
    ok: true,
    fullName: json.full_name,
    htmlUrl: json.html_url,
    cloneUrl: json.clone_url
  }
}

export async function pushPullFetch(
  workspacePath: string,
  action: 'fetch' | 'pull' | 'push',
  remoteName: string,
  branch: string | null,
  token: string | null,
  ref: GithubRepoRef | null,
  protocol: 'https' | 'ssh'
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!existsSync(join(workspacePath, '.git'))) {
    return { ok: false, error: 'Not a git repository' }
  }

  let remoteArg = remoteName
  const envExtra: Record<string, string> = {}

  // For HTTPS + token, push/pull via authenticated URL without rewriting saved remote permanently
  if (protocol === 'https' && token && ref && (action === 'push' || action === 'pull' || action === 'fetch')) {
    remoteArg = authenticatedHttpsUrl(ref, token)
  }

  const args =
    action === 'fetch'
      ? ['fetch', remoteArg]
      : action === 'pull'
        ? ['pull', remoteArg, ...(branch ? [branch] : [])]
        : ['push', '-u', remoteArg, ...(branch ? [branch] : ['HEAD'])]

  const res = await runGit(workspacePath, args, envExtra, 120_000)
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
  if (res.code !== 0) {
    return { ok: false, error: output || `${action} failed`, output }
  }
  return { ok: true, output }
}
