import { app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

export const APP_DIR_NAME = 'Eris'
export const WORKSPACE_DIR = '.eris'
export const LEGACY_WORKSPACE_DIR = '.ericservices-ide'

export function userDataRoot(): string {
  return join(app.getPath('appData'), APP_DIR_NAME)
}

export function userSettingsPath(): string {
  return join(userDataRoot(), 'settings.json')
}

export function userStatePath(): string {
  return join(userDataRoot(), 'state.json')
}

export function userChatsDir(): string {
  return join(userDataRoot(), 'chats')
}

/** Prefer `.eris`; fall back to legacy `.ericservices-ide` if present. */
export function workspaceConfigDir(workspacePath: string): string {
  const next = join(workspacePath, WORKSPACE_DIR)
  const legacy = join(workspacePath, LEGACY_WORKSPACE_DIR)
  if (existsSync(next) || !existsSync(legacy)) return next
  return legacy
}

export function workspaceSettingsPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'settings.json')
}

export function workspaceMetaPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'workspace.json')
}

export function workspaceChatsDir(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'chats')
}

export function workspaceRulesDir(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'rules')
}

/** Durable per-workspace reference notes for the agent (pinned summary each turn). */
export function workspaceContextPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'context.md')
}

export function workspaceSkillsDir(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'skills')
}

export function userSkillsDir(): string {
  return join(userDataRoot(), 'skills')
}

export function workspaceAgentsPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'agents.json')
}

function safeExists(path: string): boolean {
  try {
    return Boolean(path) && existsSync(path)
  } catch {
    // asar boundary / invalid path
    return false
  }
}

/**
 * Resolve files shipped with the app.
 * Packaged macOS layout: Contents/Resources/resources/<file> (extraResources)
 * plus a copy inside app.asar/resources/ when included in electron-builder files.
 */
function resourceCandidates(fileName: string): string[] {
  const out: string[] = []

  // 1) electron-builder extraResources → Contents/Resources/resources/...
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    out.push(join(process.resourcesPath, 'resources', fileName))
    out.push(join(process.resourcesPath, fileName))
  }

  // 2) Derive from executable (macOS): Eris.app/Contents/MacOS/Eris
  try {
    const exeDir = dirname(app.getPath('exe'))
    out.push(join(exeDir, '..', 'Resources', 'resources', fileName))
    out.push(join(exeDir, '..', 'Resources', fileName))
  } catch {
    // ignore before app ready
  }

  // 3) Inside asar / app path (dev and packaged fallback if resources are in files[])
  try {
    out.push(join(app.getAppPath(), 'resources', fileName))
  } catch {
    // ignore
  }

  // 4) Dev: repo resources/ next to electron-vite out/
  out.push(join(__dirname, '../../../resources', fileName))
  out.push(join(process.cwd(), 'resources', fileName))

  return [...new Set(out.filter(Boolean))]
}

function resolveResource(fileName: string): string {
  const candidates = resourceCandidates(fileName)
  for (const candidate of candidates) {
    if (safeExists(candidate)) return candidate
  }
  throw new Error(
    `Missing app resource “${fileName}”. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
  )
}

export function defaultsPath(): string {
  return resolveResource('defaults.json')
}

export function builtinAgentsPath(): string {
  return resolveResource('agents.json')
}

export function modelsManifestPath(): string {
  return resolveResource('models/manifest.json')
}

export function builtinModelsDir(): string {
  return join(userDataRoot(), 'models', 'builtin')
}
