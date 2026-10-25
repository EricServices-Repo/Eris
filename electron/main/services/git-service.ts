import { spawn } from 'child_process'
import { existsSync, lstatSync, readFileSync } from 'fs'
import { loadCheckpoint } from './checkpoints'
import { resolveInWorkspace } from './workspace-fs'
import { join } from 'path'
import { activeDiagnosticsScope } from './model-transport'

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

export function runGit(
  workspacePath: string,
  args: string[],
  timeoutMs = 20_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  const diagnostics = activeDiagnosticsScope()
  if (diagnostics) {
    diagnostics.onBlockedEffect('command', `git ${args.join(' ')}`)
    return Promise.resolve({
      code: 1,
      stdout: '',
      stderr: 'Host Git commands are disabled in diagnostics runs'
    })
  }
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
  let branch: string | null = branchRes.code === 0 ? branchRes.stdout.trim() : null
  let ahead = 0
  let behind = 0
  const entries: GitStatusEntry[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      const m = head.match(
        /^([^\s.]+)(?:\.\.\.[^\s]+)?(?:\s+\[(?:ahead\s+(\d+))?(?:,\s*)?(?:behind\s+(\d+))?\])?/
      )
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
      index !== ' ' && worktree !== ' ' ? `${index}${worktree}` : index !== ' ' ? index : worktree
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
  if (res.code !== 0)
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || 'commit failed' }
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
    return {
      ok: false,
      current: null,
      branches: [],
      error: res.stderr.trim() || 'git branch failed'
    }
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

export interface ReviewedCommitRequest {
  root: string
  branch: string
  head: string
  message: string
  action?: 'stage' | 'commit'
  changes: { checkpointId: string; opIndex: number }[]
}
/** --only uses Git's temporary commit index and preserves staging outside these exact paths. */
export async function gitCommitReviewed(
  root: string,
  input: ReviewedCommitRequest,
  current: () => boolean
) {
  const fail = (error: string) => ({ ok: false, error })
  if (
    !input ||
    input.root !== root ||
    !input.message?.trim() ||
    input.message.length > 10000 ||
    !Array.isArray(input.changes) ||
    !input.changes.length ||
    input.changes.length > 4096
  )
    return fail('Invalid reviewed commit request')
  const branch = await runGit(root, ['symbolic-ref', '--short', 'HEAD'])
  const head = await runGit(root, ['rev-parse', 'HEAD'])
  if (
    !current() ||
    branch.code ||
    head.code ||
    branch.stdout.trim() !== input.branch ||
    head.stdout.trim() !== input.head
  )
    return fail('Repository or branch changed; review the commit again')
  const desired = new Map<string, { before: string | null; after: string | null }>()
  const records = new Map<string, NonNullable<ReturnType<typeof loadCheckpoint>>>()
  for (const change of input.changes) {
    if (
      !/^[0-9a-f-]{36}$/i.test(change.checkpointId) ||
      !Number.isSafeInteger(change.opIndex) ||
      change.opIndex < 0
    )
      return fail('Invalid patch identity')
    const record = records.get(change.checkpointId) || loadCheckpoint(root, change.checkpointId)
    if (!record || record.workspacePath !== root)
      return fail('Patch belongs to a different workspace')
    records.set(change.checkpointId, record)
  }
  // Checkpoint operation order, never the display string, owns both sides of a rename.
  for (const [id, record] of records)
    for (const [index, op] of record.ops.entries()) {
      if (!input.changes.some((c) => c.checkpointId === id && c.opIndex === index)) continue
      const add = (path: string, before: string | null, after: string | null) => {
        const existing = desired.get(path)
        if (existing && existing.after !== before)
          throw new Error('Selected changes are not a contiguous patch; review manually')
        desired.set(path, { before: existing ? existing.before : before, after })
      }
      if (op.kind === 'write') add(op.path, op.before, op.after)
      else if (op.kind === 'delete') add(op.path, op.before, null)
      else if (op.kind === 'rename' && op.before !== undefined) {
        add(op.from, op.before, null)
        add(op.to, null, op.before)
      } else if (op.kind !== 'mkdir') return fail('Binary changes require manual Git review')
    }
  if (!desired.size) return fail('No committable patches selected')
  for (const [path, patch] of desired) {
    const absolute = resolveInWorkspace(root, path)
    if (
      existsSync(absolute) &&
      (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink())
    )
      return fail(`Unsupported file type: ${path}`)
    const disk = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
    if (disk !== patch.after)
      return fail(`User or later agent edits in ${path}; review its hunks manually`)
    const base = await runGit(root, ['show', `${input.head}:${path}`])
    const before = base.code === 0 ? base.stdout : null
    if (before !== patch.before)
      return fail(`Pre-existing changes in ${path}; review its hunks manually`)
    const staged = await runGit(root, ['show', `:${path}`])
    const indexed = staged.code === 0 ? staged.stdout : null
    if (indexed !== patch.before && indexed !== patch.after)
      return fail(`Different staged content in ${path}; preserve it with manual Git review`)
  }
  if (!current()) return fail('Workspace changed before commit')
  const latest = await runGit(root, ['rev-parse', 'HEAD'])
  const latestBranch = await runGit(root, ['symbolic-ref', '--short', 'HEAD'])
  if (
    latest.stdout.trim() !== input.head ||
    latestBranch.stdout.trim() !== input.branch ||
    !current()
  )
    return fail('Branch changed before commit')
  const staged = await runGit(root, ['--literal-pathspecs', 'add', '--', ...desired.keys()])
  if (staged.code) return fail(staged.stderr || 'Could not stage reviewed paths')
  if (input.action === 'stage') return { ok: true, root, branch: input.branch }
  const result = await runGit(root, [
    '--literal-pathspecs',
    'commit',
    '--only',
    '-m',
    input.message.trim(),
    '--',
    ...desired.keys()
  ])
  if (result.code)
    return fail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        'Commit failed; reviewed paths remain staged and unrelated staging is preserved'
    )
  const committed = await runGit(root, ['rev-parse', 'HEAD'])
  return { ok: true, root, branch: input.branch, commit: committed.stdout.trim() }
}
