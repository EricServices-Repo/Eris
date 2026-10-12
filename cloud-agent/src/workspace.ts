import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync
} from 'fs'
import { dirname, join, normalize, relative, resolve, sep } from 'path'
import { config } from './config.js'
import { assertShellAllowed } from './sandbox.js'
import { bumpMetric } from './observe.js'
import type { CloudJobFile } from './types.js'

const execFileAsync = promisify(execFile)

export function jobWorkspace(jobId: string): string {
  return join(config.dataDir, 'workspaces', jobId)
}

export function assertInWorkspace(workspace: string, relPath: string): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..')) {
    throw new Error('Invalid path')
  }
  const abs = resolve(workspace, cleaned)
  const root = resolve(workspace) + sep
  if (abs !== resolve(workspace) && !abs.startsWith(root)) {
    throw new Error('Path escapes workspace')
  }
  return abs
}

function authenticatedCloneUrl(repoUrl: string, githubToken?: string | null): string {
  const trimmed = repoUrl.trim()
  if (!githubToken?.trim()) return trimmed
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'https:') return trimmed
    // GitHub HTTPS with PAT: https://x-access-token:TOKEN@host/owner/repo.git
    u.username = 'x-access-token'
    u.password = githubToken.trim()
    return u.toString()
  } catch {
    return trimmed
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
      const cloneUrl = authenticatedCloneUrl(options.repoUrl, options.githubToken)
      const args = ['clone', '--depth', '1']
      if (options.branch?.trim()) args.push('--branch', options.branch.trim())
      args.push(cloneUrl, root)
      await execFileAsync('git', args, {
        timeout: 180_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
      // Strip credentials from remote URL so they aren't persisted in .git/config
      try {
        await execFileAsync('git', ['-C', root, 'remote', 'set-url', 'origin', options.repoUrl.trim()], {
          timeout: 10_000
        })
      } catch {
        // ignore
      }
    }
  } else {
    mkdirSync(root, { recursive: true })
  }

  const files = options.files || []
  let written = 0
  for (const f of files) {
    if (written >= config.maxFiles) break
    const path = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path.includes('..')) continue
    const content = String(f.content ?? '')
    if (Buffer.byteLength(content, 'utf8') > config.maxFileBytes) continue
    const abs = assertInWorkspace(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
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
  const lines: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (name === '.git' || name === 'node_modules' || name === '.eris-cloud') continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
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
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('Not a file')
  if (st.size > config.maxFileBytes) {
    const buf = readFileSync(abs, 'utf8')
    return `${buf.slice(0, config.maxFileBytes)}\n\n[truncated]`
  }
  return readFileSync(abs, 'utf8')
}

export function writeText(workspace: string, relPath: string, content: string): string {
  const abs = assertInWorkspace(workspace, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return relative(workspace, abs) || relPath
}

export async function runShell(
  workspace: string,
  command: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  const policy = assertShellAllowed(command)
  if (!policy.ok) {
    bumpMetric('toolDenied')
    return { ok: false, detail: policy.error }
  }
  const trimmed = command.trim()
  try {
    const { stdout, stderr } = await execFileAsync(
      'bash',
      ['-lc', trimmed],
      {
        cwd: workspace,
        timeout: 180_000,
        maxBuffer: 2_000_000,
        signal,
        env: {
          ...process.env,
          HOME: workspace,
          GIT_TERMINAL_PROMPT: '0'
        }
      }
    )
    const detail = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim() || '(no output)'
    return { ok: true, detail: detail.slice(0, 12_000) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const detail = `${e.stdout || ''}${e.stderr || e.message || String(err)}`.trim()
    return { ok: false, detail: detail.slice(0, 12_000) }
  }
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
    await execFileAsync('git', ['-C', workspace, 'config', 'user.email', 'cloud-agent@eris.local'], {
      timeout: 10_000
    })
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

    const pushUrl = authenticatedCloneUrl(repoUrl, githubToken)
    await execFileAsync('git', ['-C', workspace, 'push', '-u', pushUrl, `HEAD:${branch}`], {
      timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
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
        return u.hostname === 'github.com' ? 'https://api.github.com' : `https://${u.hostname}/api/v3`
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `PR attempt failed: ${msg.slice(0, 200)}`
  }
}

export function normalizeRel(path: string): string {
  return normalize(path).replace(/\\/g, '/')
}
