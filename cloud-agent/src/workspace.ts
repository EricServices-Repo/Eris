import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  rmSync
} from 'fs'
import { dirname, join, normalize, relative } from 'path'
import { config } from './config.js'
import { assertShellAllowed } from './sandbox.js'
import { confinedPath, readBoundedText } from './workspace-paths.js'
import { runIsolatedCommand } from './job-sandbox.js'
import { bumpMetric } from './observe.js'
import type { CloudJobFile } from './types.js'

const execFileAsync = promisify(execFile)

export function jobWorkspace(jobId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error('Invalid job ID')
  return join(config.dataDir, 'workspaces', jobId)
}

export function assertInWorkspace(workspace: string, relPath: string): string {
  if (relPath.replace(/\\/g, '/').split('/').includes('.git'))
    throw new Error('Git metadata is not an agent file')
  return confinedPath(workspace, relPath)
}

function gitEnvironment(repoUrl: string, githubToken?: string | null): NodeJS.ProcessEnv {
  const remote = new URL(repoUrl)
  if (remote.protocol !== 'https:' || remote.username || remote.password)
    throw new Error('Repository must be an HTTPS URL without embedded credentials')
  return {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...(githubToken?.trim()
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraheader`,
          GIT_CONFIG_VALUE_0:
            'AUTHORIZATION: basic ' +
            Buffer.from('x-access-token:' + githubToken.trim()).toString('base64')
        }
      : {})
  }
}

export async function prepareWorkspace(options: {
  jobId: string
  repoUrl?: string | null
  branch?: string | null
  files?: CloudJobFile[]
  githubToken?: string | null
  /** When true, keep existing workspace (resume) */
  reuse?: boolean
}): Promise<string> {
  const root = jobWorkspace(options.jobId)
  if (!options.reuse) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
    mkdirSync(root, { recursive: true })

    if (options.repoUrl?.trim()) {
      const remote = new URL(options.repoUrl)
      if (remote.protocol !== 'https:' || remote.username || remote.password)
        throw new Error('Repository must be an HTTPS URL without embedded credentials')
      const cloneUrl = options.repoUrl.trim()
      const args = ['clone', '--depth', '1']
      if (options.branch?.trim()) args.push('--branch', options.branch.trim())
      args.push('--', cloneUrl, root)
      try {
        await execFileAsync('git', args, {
          timeout: 180000,
          env: gitEnvironment(cloneUrl, options.githubToken)
        })
      } catch {
        // Git exceptions may contain remote credentials; return a fixed message only.
        rmSync(root, { recursive: true, force: true })
        throw new Error('Repository clone failed. Check its HTTPS URL, branch and authorization.')
      }
    }
  } else {
    mkdirSync(root, { recursive: true })
  }

  const files = options.files || []
  let written = 0
  for (const f of files) {
    if (written >= config.maxFiles) break
    const path = String(f.path || '')
    const content = String(f.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > config.maxFileBytes) continue
    const abs = assertInWorkspace(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(assertInWorkspace(root, path), content, 'utf8')
    written++
  }

  if (!options.reuse && !options.repoUrl && files.length === 0) {
    writeFileSync(
      join(root, 'README.md'),
      '# Eris Cloud Agent workspace\n\nNo repo or files were provided. Create the project here.\n',
      'utf8'
    )
  }

  return root
}

export function listTree(workspace: string, rel = '.', maxDepth = 3): string {
  const start = assertInWorkspace(workspace, rel === '.' ? '.' : rel)
  maxDepth = Number.isFinite(maxDepth) ? Math.max(0, Math.min(8, Math.floor(maxDepth))) : 3
  const lines: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || lines.length >= 400) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (lines.length >= 400) return
      if (name === '.git' || name === 'node_modules' || name === '.eris-cloud') continue
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
        if (st.isSymbolicLink()) continue
      } catch {
        continue
      }
      const relPath = relative(workspace, abs) || name
      lines.push(`${st.isDirectory() ? 'dir ' : 'file'} ${relPath}`)
      if (st.isDirectory() && depth < maxDepth) walk(abs, depth + 1)
      if (lines.length > 400) return
    }
  }
  walk(start, 1)
  return lines.join('\n') || '(empty)'
}

export function readText(workspace: string, relPath: string): string {
  const abs = assertInWorkspace(workspace, relPath)
  return readBoundedText(abs, config.maxFileBytes)
}

export function writeText(workspace: string, relPath: string, content: string): string {
  const abs = assertInWorkspace(workspace, relPath)
  if (Buffer.byteLength(content, 'utf8') > config.maxFileBytes)
    throw new Error('File exceeds workspace write limit')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(assertInWorkspace(workspace, relPath), content, { encoding: 'utf8', flag: 'w' })
  return relative(workspace, abs) || relPath
}

export async function runShell(
  workspace: string,
  command: string,
  signal?: AbortSignal,
  readOnly = false
): Promise<{ ok: boolean; detail: string }> {
  const policy = assertShellAllowed(command)
  if (!policy.ok) {
    bumpMetric('toolDenied')
    return { ok: false, detail: policy.error }
  }
  return runIsolatedCommand(workspace, command.trim(), signal, readOnly)
}

/** After a successful job: commit, push branch, open a GitHub PR when possible. */
export async function maybeOpenPullRequest(options: {
  workspace: string
  repoUrl: string
  baseBranch: string | null
  githubToken: string
  jobId: string
  goal: string
  filesTouched: string[]
}): Promise<string | null> {
  const { workspace, repoUrl, githubToken, jobId, goal, filesTouched } = options
  if (!filesTouched.length) return null
  if (!existsSync(join(workspace, '.git'))) return null

  const branch = `eris-cloud/${jobId.slice(0, 8)}`
  const title = `Eris Cloud Agent: ${goal.slice(0, 72)}`
  const body = [
    'Automated changes from Eris Cloud Agent.',
    '',
    `**Goal:** ${goal.slice(0, 500)}`,
    '',
    `**Files:** ${filesTouched.slice(0, 40).join(', ')}`
  ].join('\n')

  try {
    await execFileAsync(
      'git',
      ['-C', workspace, 'config', 'user.email', 'cloud-agent@eris.local'],
      {
        timeout: 10_000
      }
    )
    await execFileAsync('git', ['-C', workspace, 'config', 'user.name', 'Eris Cloud Agent'], {
      timeout: 10_000
    })
    await execFileAsync('git', ['-C', workspace, 'checkout', '-B', branch], { timeout: 30_000 })
    await execFileAsync('git', ['-C', workspace, 'add', '-A'], { timeout: 60_000 })
    const { stdout: status } = await execFileAsync(
      'git',
      ['-C', workspace, 'status', '--porcelain'],
      { timeout: 30_000 }
    )
    if (!status.trim()) return null
    await execFileAsync('git', ['-C', workspace, 'commit', '-m', title.slice(0, 72)], {
      timeout: 60_000
    })

    const pushUrl = repoUrl
    await execFileAsync('git', ['-C', workspace, 'push', '-u', pushUrl, `HEAD:${branch}`], {
      timeout: 180_000,
      env: gitEnvironment(repoUrl, githubToken)
    })

    // Parse owner/repo from URL
    let owner = ''
    let repo = ''
    try {
      const u = new URL(repoUrl.replace(/\.git$/, ''))
      const parts = u.pathname.replace(/^\/+/, '').split('/')
      owner = parts[0] || ''
      repo = (parts[1] || '').replace(/\.git$/, '')
    } catch {
      return `branch ${branch} pushed (could not parse repo for PR)`
    }
    if (!owner || !repo) return `branch ${branch} pushed`

    const apiHost = (() => {
      try {
        const u = new URL(repoUrl)
        return u.hostname === 'github.com'
          ? 'https://api.github.com'
          : `https://${u.hostname}/api/v3`
      } catch {
        return 'https://api.github.com'
      }
    })()

    const base = options.baseBranch?.trim() || 'main'
    const res = await fetch(`${apiHost}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'eris-cloud-agent',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, head: branch, base, body }),
      signal: AbortSignal.timeout(30_000)
    })
    const data = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string }
    if (res.ok && data.html_url) return data.html_url
    return `branch ${branch} pushed; PR API: ${data.message || res.status}`
  } catch {
    return 'PR attempt failed. Check repository authorization and branch access.'
  }
}

export function normalizeRel(path: string): string {
  return normalize(path).replace(/\\/g, '/')
}
