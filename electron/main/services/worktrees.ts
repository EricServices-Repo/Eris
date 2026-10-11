import { existsSync, mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { userDataRoot } from './paths'
import { workspaceKey } from './workspace-trust'
import { runGit } from './git-service'

export interface WorktreeInfo {
  path: string
  branch: string
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
  const branch = agentBranchName(jobId)
  const dest = join(worktreeRoot(workspacePath), jobId)
  mkdirSync(worktreeRoot(workspacePath), { recursive: true })
  const add = await runGit(workspacePath, ['worktree', 'add', '-b', branch, dest, 'HEAD'], 60_000)
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
  return { path: dest, branch }
}

export async function removeAgentWorktree(workspacePath: string, info: WorktreeInfo): Promise<void> {
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
  branch: string
): Promise<{ ok: boolean; error?: string; output?: string }> {
  const res = await runGit(workspacePath, ['merge', '--no-ff', '--no-edit', branch], 60_000)
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
  if (res.code !== 0) return { ok: false, error: output || 'merge failed', output }
  return { ok: true, output }
}
