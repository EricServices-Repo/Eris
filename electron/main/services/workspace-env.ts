import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { delimiter, join } from 'path'
import { homedir } from 'os'

/**
 * Local tool bins that should win over the host PATH inside a workspace.
 * Keeps npm/pnpm/yarn/python CLIs self-contained after install.
 */
export function workspaceLocalBinDirs(workspacePath: string): string[] {
  const candidates = [
    join(workspacePath, 'node_modules', '.bin'),
    join(workspacePath, '.venv', 'bin'),
    join(workspacePath, 'venv', 'bin'),
    join(workspacePath, '.venv', 'Scripts'), // Windows
    join(workspacePath, 'venv', 'Scripts'),
    join(workspacePath, 'bin')
  ]
  return candidates.filter((p) => existsSync(p))
}

/** Ensure workspace-local npm cache dir exists (does not force global installs elsewhere). */
export function ensureWorkspaceNpmCache(workspacePath: string): string {
  const cache = join(workspacePath, '.eris', 'cache', 'npm')
  try {
    mkdirSync(cache, { recursive: true })
  } catch {
    // ignore
  }
  return cache
}

let cachedMacToolDirs: string[] | null = null

/** Common dirs GUI apps miss when launched from Dock/Finder (no login-shell PATH). */
function macToolBinDirs(): string[] {
  if (cachedMacToolDirs) return cachedMacToolDirs
  const home = homedir()
  const dirs: string[] = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.fnm', 'current', 'bin')
  ]

  // Active nvm default / latest installed node
  const nvmRoot = process.env.NVM_DIR || join(home, '.nvm')
  const nvmVersions = join(nvmRoot, 'versions', 'node')
  if (existsSync(nvmVersions)) {
    try {
      const versions = readdirSync(nvmVersions)
        .filter((v) => existsSync(join(nvmVersions, v, 'bin', 'npm')))
        .sort()
      const last = versions[versions.length - 1]
      if (last) dirs.push(join(nvmVersions, last, 'bin'))
    } catch {
      // ignore
    }
  }

  cachedMacToolDirs = dirs.filter((p) => existsSync(p))
  return cachedMacToolDirs
}

/** Host tool PATH without per-workspace local bins (cached). */
let cachedHostToolPath: string | null = null

function hostToolPath(): string {
  if (cachedHostToolPath) return cachedHostToolPath
  const pathKey = process.env.PATH !== undefined ? 'PATH' : 'Path'
  const hostPath = process.env[pathKey] || process.env.PATH || ''
  cachedHostToolPath = mergePathParts(
    resolveLoginShellPath(),
    hostPath,
    macToolBinDirs().join(delimiter),
    '/usr/bin',
    '/bin'
  )
  return cachedHostToolPath
}

/** Cached login-shell PATH; null = resolved empty; undefined = not warmed yet. */
let cachedLoginPath: string | null | undefined
let loginPathWarmStarted = false

/**
 * Cached login-shell PATH only — never blocks the Electron main process.
 * Call {@link warmLoginShellPath} at startup to fill the cache in the background.
 */
export function resolveLoginShellPath(): string {
  return cachedLoginPath || ''
}

/**
 * Resolve PATH from an interactive login shell without blocking IPC.
 * Dock/Finder launches omit Homebrew/nvm; this fills that gap after first paint.
 */
export function warmLoginShellPath(): void {
  if (loginPathWarmStarted) return
  loginPathWarmStarted = true

  const shell = process.env.SHELL || '/bin/zsh'
  execFile(
    shell,
    ['-ilc', 'printenv PATH'],
    {
      encoding: 'utf8',
      timeout: 4000,
      env: { ...process.env, TERM: 'dumb' }
    },
    (err, stdout) => {
      const next = !err && stdout?.trim() ? stdout.trim() : null
      cachedLoginPath = next
      // Rebuild host PATH on next use so Homebrew/nvm bins appear.
      cachedHostToolPath = null
    }
  )
}

/** For tests / after user changes shell config mid-session. */
export function clearLoginShellPathCache(): void {
  cachedLoginPath = undefined
  loginPathWarmStarted = false
  cachedMacToolDirs = null
  cachedHostToolPath = null
}

function mergePathParts(...parts: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const seg of part.split(delimiter)) {
      const s = seg.trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out.join(delimiter)
}

/**
 * Env for shell/debug/verify runs: cwd is the workspace; PATH prefers local bins
 * then login-shell / Homebrew tools so `npm` works when Eris is opened from Dock.
 */
export function buildWorkspaceProcessEnv(
  workspacePath: string,
  extra?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const localBins = workspaceLocalBinDirs(workspacePath)
  const pathKey = process.env.PATH !== undefined ? 'PATH' : 'Path'

  // Local workspace bins first, then cached login/Homebrew PATH.
  const nextPath = mergePathParts(localBins.join(delimiter), hostToolPath())

  const npmCache = ensureWorkspaceNpmCache(workspacePath)
  const venv =
    localBins.find((p) => p.endsWith(`${join('.venv', 'bin')}`) || p.endsWith(`${join('venv', 'bin')}`)) ||
    localBins.find((p) => /[/\\]\.venv[/\\]Scripts$/i.test(p) || /[/\\]venv[/\\]Scripts$/i.test(p))

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    FORCE_COLOR: '0',
    [pathKey]: nextPath,
    // Prefer project installs; never imply a global npm prefix for this shell.
    npm_config_global: 'false',
    npm_config_fund: 'false',
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: process.env.NPM_CONFIG_AUDIT || 'false'
  }

  if (venv) {
    env.VIRTUAL_ENV = join(venv, '..')
  }

  env.ERIS_WORKSPACE = workspacePath

  return env
}
