import { existsSync, statSync } from 'fs'
import { join } from 'path'

/** Detect dependency-install commands the model loves to loop on. */
export function isInstallCommand(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (!c) return false
  if (/^(npm|pnpm|yarn)\s+(i|install|ci)(\s|$)/.test(c)) return true
  if (/^npm\s+install\b/.test(c) || /^pnpm\s+install\b/.test(c) || /^yarn\s+install\b/.test(c)) {
    return true
  }
  // bun install / bun i
  if (/^bun\s+(i|install)(\s|$)/.test(c)) return true
  // pip / poetry into workspace venv
  if (/^(pip3?|python3?\s+-m\s+pip)\s+install\b/.test(c)) return true
  if (/^poetry\s+install\b/.test(c)) return true
  return false
}

/** Global installs break self-contained workspaces — always block. */
export function isGlobalInstallCommand(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (/\bnpm\s+(i|install)\s+(-g|--global)\b/.test(c)) return true
  if (/\bnpm\s+(-g|--global)\s+(i|install)\b/.test(c)) return true
  if (/\byarn\s+global\s+add\b/.test(c)) return true
  if (/\bpnpm\s+add\s+(-g|--global)\b/.test(c)) return true
  if (/\bpip3?\s+install\s+.*\s--user\b/.test(c)) return false // --user is ok-ish; still prefer venv
  return false
}

/** `npm install lodash` / `npm i -D jest` — adding packages, not a bare reinstall. */
export function isPackageAddInstall(command: string): boolean {
  const c = command.trim()
  // Strip flags to see if a package name remains after install/i/add
  const cleaned = c
    .replace(/\s+--?(save-dev|save|dev|D|P|production|legacy-peer-deps|no-save|exact|E|global|g)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    /^(npm|pnpm)\s+(i|install)\s+\S+/i.test(cleaned) ||
    /^yarn\s+add\s+\S+/i.test(cleaned) ||
    /^(pip3?|python3?\s+-m\s+pip)\s+install\s+\S+/i.test(cleaned)
  )
}

/** Max bare reinstalls per agent run (anti-loop). Package adds are unlimited. */
export const MAX_BARE_INSTALLS_PER_RUN = 2

export function hasNodeModules(workspacePath: string): boolean {
  // Require .bin — a folder named node_modules without .bin is a broken install.
  return (
    existsSync(join(workspacePath, 'node_modules')) &&
    existsSync(join(workspacePath, 'node_modules', '.bin'))
  )
}

/** True when package.json is newer than node_modules (deps likely out of date). */
export function packageJsonNewerThanModules(workspacePath: string): boolean {
  const pkg = join(workspacePath, 'package.json')
  const mods = join(workspacePath, 'node_modules')
  if (!existsSync(pkg)) return false
  if (!existsSync(mods) || !existsSync(join(mods, '.bin'))) return true
  try {
    return statSync(pkg).mtimeMs > statSync(mods).mtimeMs + 1000
  } catch {
    return true
  }
}

export function looksLikeMissingDeps(detail: string): boolean {
  return /cannot find module|module not found|enoent.*node_modules|err! missing:|could not resolve dependency|error: cannot find package/i.test(
    detail
  )
}
