import { existsSync, mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { userDataRoot } from './paths'
import { workspaceKey } from './workspace-trust'
import { runGit } from './git-service'

export interface WorktreeInfo {
  path: string
  branch: string
  destinationBranch?: string
  baseSha?: string
}

export function worktreeRoot(workspacePath: string): string {
  return join(userDataRoot(), 'worktrees', workspaceKey(workspacePath).replace(/[\\/:]/g, '_'))
}

export function agentBranchName(jobId: string): string {
  return `eris/agent/${jobId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24)}`
}

export async function isGitRepo(workspacePath: string): Promise<boolean> {
  const res = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  return res.code === 0 && res.stdout.trim() === 'true'
}

export async function addAgentWorktree(
  workspacePath: string,
  jobId: string,
  linkNodeModules: boolean
): Promise<WorktreeInfo> {
  if (!(await isGitRepo(workspacePath))) {
    throw new Error('Background agents need a git repository so each run can have its own worktree')
  }
  const destination = await runGit(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const base = await runGit(workspacePath, ['rev-parse', 'HEAD'])
  if (destination.code !== 0 || base.code !== 0)
    throw new Error('Choose an integration branch before starting a background job')
  const branch = agentBranchName(jobId)
  const dest = join(worktreeRoot(workspacePath), jobId)
  mkdirSync(worktreeRoot(workspacePath), { recursive: true })
  const add = await runGit(
    workspacePath,
    ['worktree', 'add', '-b', branch, dest, base.stdout.trim()],
    60_000
  )
  if (add.code !== 0) {
    throw new Error(add.stderr.trim() || add.stdout.trim() || 'git worktree add failed')
  }
  if (linkNodeModules) {
    const src = join(workspacePath, 'node_modules')
    const target = join(dest, 'node_modules')
    if (existsSync(src) && !existsSync(target)) {
      try {
        symlinkSync(src, target, 'junction')
      } catch {
        // optional
      }
    }
  }
  return {
    path: dest,
    branch,
    destinationBranch: destination.stdout.trim(),
    baseSha: base.stdout.trim()
  }
}

export async function removeAgentWorktree(
  workspacePath: string,
  info: WorktreeInfo
): Promise<void> {
  await runGit(workspacePath, ['worktree', 'remove', '--force', info.path], 60_000)
  await runGit(workspacePath, ['branch', '-D', info.branch])
}

export async function diffWorktree(
  workspacePath: string,
  branch: string
): Promise<{ ok: boolean; diff: string; error?: string }> {
  const res = await runGit(workspacePath, ['diff', `HEAD...${branch}`], 60_000)
  if (res.code !== 0 && !res.stdout) {
    return { ok: false, diff: '', error: res.stderr.trim() || 'diff failed' }
  }
  return { ok: true, diff: res.stdout || '(no changes)' }
}

export async function mergeAgentBranch(
  workspacePath: string,
  branch: string,
  expected?: { branch: string; baseSha: string }
): Promise<{ ok: boolean; error?: string; output?: string; commit?: string }> {
  if (!expected) return { ok: false, error: 'An integration baseline is required' }
  const target = await runGit(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const head = await runGit(workspacePath, ['rev-parse', 'HEAD'])
  const dirty = await runGit(workspacePath, ['status', '--porcelain'])
  if (
    target.code !== 0 ||
    head.code !== 0 ||
    target.stdout.trim() !== expected.branch ||
    head.stdout.trim() !== expected.baseSha
  )
    return {
      ok: false,
      error: 'Integration branch or baseline changed. Rebase and review the job before merging.'
    }
  if (dirty.code !== 0 || dirty.stdout.trim())
    return { ok: false, error: 'Save or commit destination changes before integrating the job.' }
  const res = await runGit(workspacePath, ['merge', '--no-ff', '--no-edit', branch], 60_000)
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
  if (res.code !== 0) return { ok: false, error: output || 'merge failed', output }
  const commit = await runGit(workspacePath, ['rev-parse', 'HEAD'])
  return { ok: true, output, commit: commit.stdout.trim() }
}
