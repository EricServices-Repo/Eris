import { spawn } from 'child_process'
import { existsSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

export interface SandboxPlan {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
}
/** No host home, service environment, network, peer workspace or service mount is admitted. */
export function sandboxPlan(workspace: string, command: string, readOnly = false): SandboxPlan {
  if (process.platform !== 'linux')
    throw new Error('Cloud command isolation requires Linux with bubblewrap and user namespaces.')
  const root = realpathSync(workspace)
  const args = [
    '--as=4294967296',
    '--cpu=120',
    '--nofile=256',
    '--fsize=67108864',
    '--',
    '/usr/bin/bwrap',
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--size',
    '67108864',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home',
    '--dir',
    '/home/job',
    '--dir',
    '/etc'
  ]
  for (const path of ['/usr', '/bin', '/lib', '/lib64']) {
    if (existsSync(path)) args.push('--ro-bind', path, path)
  }
  args.push(readOnly ? '--ro-bind' : '--bind', root, '/workspace')
  // Hide repository metadata even from approved shell commands. Publishing is a separate authority-checked service.
  if (existsSync(root + '/.git')) args.push('--size', '1048576', '--tmpfs', '/workspace/.git')
  args.push(
    '--chdir',
    '/workspace',
    '--setenv',
    'HOME',
    '/home/job',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'GIT_TERMINAL_PROMPT',
    '0',
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-c',
    command
  )
  return { executable: '/usr/bin/prlimit', args, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }
}

/** Aggregate limits cover all descendants, including children that change session/process group. */
function createJobCgroup(): string {
  const configured = process.env.ERIS_CLOUD_CGROUP_ROOT
  if (!configured)
    throw new Error(
      'Cloud commands require ERIS_CLOUD_CGROUP_ROOT: a delegated cgroup v2 subtree. No host fallback is permitted.'
    )
  const root = realpathSync(configured)
  if (!root.startsWith('/sys/fs/cgroup/'))
    throw new Error('Job cgroups must live in a delegated /sys/fs/cgroup subtree')
  const group = join(root, 'eris-job-' + randomUUID())
  mkdirSync(group)
  try {
    writeFileSync(join(group, 'memory.max'), '4294967296')
    writeFileSync(join(group, 'memory.swap.max'), '0')
    writeFileSync(join(group, 'memory.oom.group'), '1')
    writeFileSync(join(group, 'pids.max'), '128')
    writeFileSync(join(group, 'cpu.max'), '100000 100000')
    // cgroup.kill is required to terminate descendants that escape the shell process group.
    if (!existsSync(join(group, 'cgroup.kill'))) throw new Error('cgroup.kill is unavailable')
    return group
  } catch {
    try {
      rmdirSync(group)
    } catch {
      /* empty unconfigured group */
    }
    throw new Error('Cannot apply delegated cgroup limits; command was not started.')
  }
}

export async function runIsolatedCommand(
  workspace: string,
  command: string,
  signal?: AbortSignal,
  readOnly = false
): Promise<{ ok: boolean; detail: string }> {
  if (signal?.aborted) return { ok: false, detail: 'Command cancelled before admission.' }
  let plan: SandboxPlan
  let group: string
  try {
    plan = sandboxPlan(workspace, command, readOnly)
    group = createJobCgroup()
  } catch (error) {
    return { ok: false, detail: String(error) }
  }
  return new Promise((resolve) => {
    // The trusted shell joins the cgroup before exec; untrusted code cannot race admission.
    const child = spawn(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"',
        'eris-job',
        group,
        plan.executable,
        ...plan.args
      ],
      {
        env: plan.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    let reason: string | null = null
    let settled = false
    const kill = (why: string) => {
      reason ??= why
      try {
        writeFileSync(join(group, 'cgroup.kill'), '1')
      } catch {
        /* process-group fallback below */
      }
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already stopped */
      }
    }
    const timer = setTimeout(() => kill('Command exceeded its 180 second wall-time limit.'), 180000)
    const abort = () => kill('Command cancelled.')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const collect = (data: Buffer) => {
      if (output.length + data.length > 2_000_000) kill('Command exceeded its output limit.')
      output = (output + data.toString('utf8')).slice(0, 2_000_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const finish = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try {
        const memory = readFileSync(join(group, 'memory.events'), 'utf8')
        if (/^oom_kill [1-9]/m.test(memory))
          reason ??= 'Command exceeded its aggregate memory limit.'
        writeFileSync(join(group, 'cgroup.kill'), '1')
      } catch {
        reason ??= 'Job cgroup cleanup failed; check the delegated limits.'
      }
      // Kill leftover descendants even when the shell itself exits successfully.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* none remain */
      }
      try {
        rmdirSync(group)
      } catch {
        setTimeout(() => {
          try {
            rmdirSync(group)
          } catch {
            /* empty group retained for operator cleanup */
          }
        }, 100).unref()
      }
      resolve({
        ok: ok && !reason,
        detail: (reason ?? error ?? output.trim() ?? '(no output)').slice(0, 12000)
      })
    }
    child.once('error', () =>
      finish(
        false,
        'Command sandbox unavailable. Install bubblewrap/prlimit and enable unprivileged user namespaces; no host fallback was attempted.'
      )
    )
    child.once('close', (code) => finish(code === 0))
  })
}
