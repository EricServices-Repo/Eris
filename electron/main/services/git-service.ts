import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

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

function runGit(
  workspacePath: string,
  args: string[],
  timeoutMs = 20_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: workspacePath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += String(d)
      if (stdout.length > 2_000_000) child.kill('SIGTERM')
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

export async function gitStatus(workspacePath: string): Promise<GitStatusResult> {
  if (!existsSync(join(workspacePath, '.git'))) {
    return {
      ok: false,
      error: 'Not a git repository',
      branch: null,
      ahead: 0,
      behind: 0,
      entries: []
    }
  }
  const branchRes = await runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const statusRes = await runGit(workspacePath, ['status', '--porcelain=1', '-b'])
  if (statusRes.code !== 0 && !statusRes.stdout) {
    return {
      ok: false,
      error: statusRes.stderr.trim() || 'git status failed',
      branch: null,
      ahead: 0,
      behind: 0,
      entries: []
    }
  }
  const lines = statusRes.stdout.split('\n').filter(Boolean)
  let branch: string | null =
    branchRes.code === 0 ? branchRes.stdout.trim() : null
  let ahead = 0
  let behind = 0
  const entries: GitStatusEntry[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      const m = head.match(/^([^\s.]+)(?:\.\.\.[^\s]+)?(?:\s+\[(?:ahead\s+(\d+))?(?:,\s*)?(?:behind\s+(\d+))?\])?/)
      if (m) {
        branch = m[1] || branch
        ahead = m[2] ? Number(m[2]) : 0
        behind = m[3] ? Number(m[3]) : 0
      }
      continue
    }
    const index = line[0] || ' '
    const worktree = line[1] || ' '
    const path = line.slice(3).trim()
    if (!path) continue
    const status =
      index !== ' ' && worktree !== ' '
        ? `${index}${worktree}`
        : index !== ' '
          ? index
          : worktree
    entries.push({ path, index, worktree, status })
  }
  return { ok: true, branch, ahead, behind, entries }
}

export async function gitDiff(
  workspacePath: string,
  path?: string
): Promise<{ ok: boolean; diff: string; error?: string }> {
  const args = path ? ['diff', '--', path] : ['diff']
  const res = await runGit(workspacePath, args)
  if (res.code !== 0 && !res.stdout) {
    return { ok: false, diff: '', error: res.stderr.trim() || 'git diff failed' }
  }
  return { ok: true, diff: res.stdout || '(no unstaged changes)' }
}

export async function gitStage(
  workspacePath: string,
  paths: string[]
): Promise<{ ok: boolean; error?: string }> {
  if (paths.length === 0) return { ok: false, error: 'No paths to stage' }
  const res = await runGit(workspacePath, ['add', '--', ...paths])
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'git add failed' }
  return { ok: true }
}

export async function gitCommit(
  workspacePath: string,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  const msg = message.trim()
  if (!msg) return { ok: false, error: 'Commit message required' }
  const res = await runGit(workspacePath, ['commit', '-m', msg])
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || res.stdout.trim() || 'commit failed' }
  return { ok: true }
}

export async function gitBranches(
  workspacePath: string
): Promise<{ ok: boolean; current: string | null; branches: string[]; error?: string }> {
  if (!existsSync(join(workspacePath, '.git'))) {
    return { ok: false, current: null, branches: [], error: 'Not a git repository' }
  }
  const res = await runGit(workspacePath, ['branch', '--list', '--format=%(refname:short)'])
  if (res.code !== 0) {
    return { ok: false, current: null, branches: [], error: res.stderr.trim() || 'git branch failed' }
  }
  const branches = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const cur = await runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return {
    ok: true,
    current: cur.code === 0 ? cur.stdout.trim() : null,
    branches
  }
}

export async function gitCheckout(
  workspacePath: string,
  branch: string,
  create = false
): Promise<{ ok: boolean; error?: string }> {
  const name = branch.trim()
  if (!name) return { ok: false, error: 'Branch name required' }
  const args = create ? ['checkout', '-b', name] : ['checkout', name]
  const res = await runGit(workspacePath, args)
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || 'checkout failed' }
  }
  return { ok: true }
}

export async function gitStash(
  workspacePath: string,
  action: 'push' | 'pop' | 'list' = 'push',
  message?: string
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const args =
    action === 'list'
      ? ['stash', 'list']
      : action === 'pop'
        ? ['stash', 'pop']
        : message?.trim()
          ? ['stash', 'push', '-m', message.trim()]
          : ['stash', 'push']
  const res = await runGit(workspacePath, args)
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
  if (res.code !== 0) return { ok: false, error: output || `stash ${action} failed`, output }
  return { ok: true, output }
}
