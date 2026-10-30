import { dialog, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { WorkspaceMeta, WorkspaceRecord } from '../../../src/shared/settings-schema'
import {
  userStatePath,
  userDataRoot,
  workspaceConfigDir,
  workspaceMetaPath,
  workspaceRulesDir
} from './paths'
import { seedProjectAgents } from './agents'
import { ensureSkillsDirs } from './skills'
import { ensureWorkspaceContext } from './workspace-context'
import { realpathAllowMissing } from './workspace-fs'

export interface AppState {
  workspaces: WorkspaceRecord[]
  lastWorkspaceId: string | null
  /** Epoch ms when first-run setup wizard was finished or skipped */
  onboardingCompletedAt?: number | null
  /** @deprecated migrated into workspaces */
  recentPaths?: string[]
  lastWorkspacePath?: string | null
}

const DEFAULT_STATE: AppState = {
  workspaces: [],
  lastWorkspaceId: null,
  onboardingCompletedAt: null
}

const DEFAULT_META: WorkspaceMeta = {
  openFiles: [],
  activeFile: null,
  activeChatId: null,
  lastModel: null
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) } as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

function sanitizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80) || 'workspace'
}

export function initializeWorkspaceFolder(folderPath: string): void {
  mkdirSync(folderPath, { recursive: true })
  mkdirSync(workspaceConfigDir(folderPath), { recursive: true })
  mkdirSync(join(workspaceConfigDir(folderPath), 'cache', 'npm'), { recursive: true })
  mkdirSync(workspaceRulesDir(folderPath), { recursive: true })
  const metaPath = workspaceMetaPath(folderPath)
  if (!existsSync(metaPath)) {
    writeJson(metaPath, DEFAULT_META)
  }
  seedProjectAgents(folderPath, false)
  ensureSkillsDirs(folderPath)
  const readme = join(workspaceRulesDir(folderPath), 'README.md')
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      '# Workspace rules\n\nAdd `.md` rule files here. They are injected into the agent system prompt.\n',
      'utf8'
    )
  }
  // Keep installs and tooling artifacts local to the workspace folder.
  const gitignore = join(folderPath, '.gitignore')
  if (!existsSync(gitignore)) {
    writeFileSync(
      gitignore,
      [
        'node_modules/',
        '.eris/cache/',
        '.venv/',
        'venv/',
        'dist/',
        'build/',
        '.DS_Store',
        '*.log',
        ''
      ].join('\n'),
      'utf8'
    )
  }
  ensureWorkspaceContext(folderPath)
}

function migrateState(raw: AppState): AppState {
  const workspaces = [...(raw.workspaces ?? [])]
  const seen = new Set(workspaces.map((w) => w.path))

  for (const path of raw.recentPaths ?? []) {
    if (!path || seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    const now = Date.now()
    workspaces.push({
      id: randomUUID(),
      name: basename(path),
      path,
      createdAt: now,
      lastOpenedAt: now
    })
  }

  if (raw.lastWorkspacePath && existsSync(raw.lastWorkspacePath) && !seen.has(raw.lastWorkspacePath)) {
    const now = Date.now()
    workspaces.push({
      id: randomUUID(),
      name: basename(raw.lastWorkspacePath),
      path: raw.lastWorkspacePath,
      createdAt: now,
      lastOpenedAt: now
    })
  }

  let lastWorkspaceId = raw.lastWorkspaceId ?? null
  if (!lastWorkspaceId && raw.lastWorkspacePath) {
    lastWorkspaceId = workspaces.find((w) => w.path === raw.lastWorkspacePath)?.id ?? null
  }

  workspaces.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

  // Existing installs (already have workspaces) skip the first-run wizard.
  let onboardingCompletedAt =
    typeof raw.onboardingCompletedAt === 'number' ? raw.onboardingCompletedAt : null
  if (onboardingCompletedAt == null && workspaces.length > 0) {
    onboardingCompletedAt = Date.now()
  }

  return {
    workspaces,
    lastWorkspaceId,
    onboardingCompletedAt
  }
}

export function getAppState(): AppState {
  mkdirSync(userDataRoot(), { recursive: true })
  const raw = readJson<AppState>(userStatePath(), DEFAULT_STATE)
  const migrated = migrateState(raw)
  if (
    JSON.stringify({
      workspaces: raw.workspaces ?? [],
      lastWorkspaceId: raw.lastWorkspaceId ?? null,
      onboardingCompletedAt: raw.onboardingCompletedAt ?? null
    }) !==
    JSON.stringify({
      workspaces: migrated.workspaces,
      lastWorkspaceId: migrated.lastWorkspaceId,
      onboardingCompletedAt: migrated.onboardingCompletedAt ?? null
    })
  ) {
    writeJson(userStatePath(), migrated)
  }
  return migrated
}

export function setAppState(patch: Partial<AppState>): AppState {
  const current = getAppState()
  const next: AppState = {
    workspaces: patch.workspaces ?? current.workspaces,
    lastWorkspaceId:
      patch.lastWorkspaceId !== undefined ? patch.lastWorkspaceId : current.lastWorkspaceId,
    onboardingCompletedAt:
      patch.onboardingCompletedAt !== undefined
        ? patch.onboardingCompletedAt
        : current.onboardingCompletedAt ?? null
  }
  writeJson(userStatePath(), next)
  return next
}

export function completeOnboarding(): AppState {
  return setAppState({ onboardingCompletedAt: Date.now() })
}

export function resetOnboarding(): AppState {
  return setAppState({ onboardingCompletedAt: null })
}

export function listWorkspaces(): WorkspaceRecord[] {
  return getAppState().workspaces
}

export function getWorkspaceById(id: string): WorkspaceRecord | null {
  return getAppState().workspaces.find((w) => w.id === id) ?? null
}

export function getWorkspaceByPath(path: string): WorkspaceRecord | null {
  return getAppState().workspaces.find((w) => w.path === path) ?? null
}

/**
 * Main-owned registration behind a root, read only from profile state so copied
 * `.eris` metadata cannot assert one. Aliases of a folder share its oldest record.
 */
export function registeredWorkspaceId(path: string): string | null {
  const canonical = realpathAllowMissing(path)
  const [owner] = getAppState()
    .workspaces.filter((workspace) => realpathAllowMissing(workspace.path) === canonical)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return owner?.id ?? null
}

export function rememberWorkspace(
  workspacePath: string,
  options?: { name?: string; id?: string }
): WorkspaceRecord {
  initializeWorkspaceFolder(workspacePath)
  const state = getAppState()
  const now = Date.now()
  const existing = state.workspaces.find((w) => w.path === workspacePath || (options?.id && w.id === options.id))

  let record: WorkspaceRecord
  if (existing) {
    record = {
      ...existing,
      name: options?.name?.trim() || existing.name,
      path: workspacePath,
      lastOpenedAt: now
    }
    const workspaces = [
      record,
      ...state.workspaces.filter((w) => w.id !== existing.id)
    ]
    setAppState({ workspaces, lastWorkspaceId: record.id })
  } else {
    record = {
      id: options?.id ?? randomUUID(),
      name: options?.name?.trim() || basename(workspacePath),
      path: workspacePath,
      createdAt: now,
      lastOpenedAt: now
    }
    setAppState({
      workspaces: [record, ...state.workspaces],
      lastWorkspaceId: record.id
    })
  }
  return record
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord | null {
  const state = getAppState()
  const trimmed = name.trim()
  if (!trimmed) return null
  const workspaces = state.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
  setAppState({ workspaces })
  return workspaces.find((w) => w.id === id) ?? null
}

export function removeWorkspace(id: string): AppState {
  const state = getAppState()
  const workspaces = state.workspaces.filter((w) => w.id !== id)
  const lastWorkspaceId =
    state.lastWorkspaceId === id ? (workspaces[0]?.id ?? null) : state.lastWorkspaceId
  return setAppState({ workspaces, lastWorkspaceId })
}

/** Link an existing folder as a named workspace */
export async function linkWorkspaceDialog(
  win: BrowserWindow,
  name?: string
): Promise<WorkspaceRecord | null> {
  const result = await dialog.showOpenDialog(win, {
    title: 'Link Folder as Workspace',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  return rememberWorkspace(path, { name: name || basename(path) })
}

/** Create a new folder workspace under a chosen parent directory */
export async function createWorkspaceDialog(
  win: BrowserWindow,
  name: string
): Promise<WorkspaceRecord | null> {
  const trimmed = name.trim()
  if (!trimmed) return null

  const parent = await dialog.showOpenDialog(win, {
    title: 'Choose parent folder for new workspace',
    message: `Create workspace “${trimmed}” inside:`,
    properties: ['openDirectory', 'createDirectory']
  })
  if (parent.canceled || parent.filePaths.length === 0) return null

  const folderName = sanitizeFolderName(trimmed)
  let target = join(parent.filePaths[0], folderName)
  if (existsSync(target)) {
    target = join(parent.filePaths[0], `${folderName}-${Date.now().toString(36)}`)
  }

  initializeWorkspaceFolder(target)
  return rememberWorkspace(target, { name: trimmed })
}

/** @deprecated use linkWorkspaceDialog */
export async function openWorkspaceDialog(win: BrowserWindow): Promise<string | null> {
  const record = await linkWorkspaceDialog(win)
  return record?.path ?? null
}

export function getWorkspaceMeta(workspacePath: string): WorkspaceMeta {
  return readJson(workspaceMetaPath(workspacePath), DEFAULT_META)
}

export function setWorkspaceMeta(workspacePath: string, meta: WorkspaceMeta): WorkspaceMeta {
  mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
  writeJson(workspaceMetaPath(workspacePath), meta)
  return meta
}
