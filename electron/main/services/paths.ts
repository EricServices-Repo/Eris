import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

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

function resourceCandidates(fileName: string): string[] {
  return [
    join(process.resourcesPath ?? '', 'resources', fileName),
    join(app.getAppPath(), 'resources', fileName),
    join(__dirname, '../../../resources', fileName),
    join(process.cwd(), 'resources', fileName)
  ]
}

export function defaultsPath(): string {
  const candidates = resourceCandidates('defaults.json')
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return candidates[1]
}

export function builtinAgentsPath(): string {
  const candidates = resourceCandidates('agents.json')
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return candidates[1]
}

export function modelsManifestPath(): string {
  const candidates = resourceCandidates('models/manifest.json')
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return candidates[1]
}

export function builtinModelsDir(): string {
  return join(userDataRoot(), 'models', 'builtin')
}
