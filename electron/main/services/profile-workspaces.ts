import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { userDataRoot, workspaceConfigDir } from './paths'
import { getAppState, setAppState } from './workspace'
import { getWorkspaceSettings } from './settings'
import { listChats, getChat, saveChat } from './chats'
import { listSkills, upsertSkill, type SyncableSkill } from './skills'
import type { ChatThread, WorkspaceRecord } from '../../../src/shared/settings-schema'

export interface SyncedProject {
  id: string
  name: string
  repositoryUrl: string
  createdAt: number
  lastOpenedAt: number
  chats: ChatThread[]
  skills?: SyncableSkill[]
}
const validId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id)
export function portableRepositoryUrl(value: string): string {
  if (/^git@[^\s:]+:[^\s?#]+$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}
function repositoryFor(project: WorkspaceRecord): string {
  try {
    const config = readFileSync(join(project.path, '.git', 'config'), 'utf8')
    const origin = config
      .match(/\[remote "origin"\]([^[]+)/)?.[1]
      ?.match(/url\s*=\s*(.+)/)?.[1]
      ?.trim()
    if (origin) return portableRepositoryUrl(origin)
  } catch {
    /* Project may not have a repository on this computer. */
  }
  const github = getWorkspaceSettings(project.path).github
  if (github?.repository)
    return portableRepositoryUrl(`https://${github.host || 'github.com'}/${github.repository}`)
  return portableRepositoryUrl(project.repositoryUrl || '')
}
async function exportChats(path: string | null): Promise<ChatThread[]> {
  const result: ChatThread[] = []
  for (const header of await listChats(path)) {
    const chat = await getChat(path, header.id)
    if (
      !chat ||
      (chat.messageOffset ?? 0) !== 0 ||
      (chat.messageCount !== undefined && chat.messageCount !== chat.messages.length)
    )
      throw new Error(
        'Could not load a complete conversation for profile sync. Nothing was uploaded.'
      )
    // Local image paths and runtime tool state are deliberately not exported.
    result.push({
      ...chat,
      messages: chat.messages.map(
        ({ id, role, content, thinking, createdAt, agentId, agentName, model }) => ({
          id,
          role,
          content,
          thinking,
          createdAt,
          agentId,
          agentName,
          model
        })
      )
    })
  }
  return result
}
export async function exportProfileWorkspaces(): Promise<{
  projects: SyncedProject[]
  chats: ChatThread[]
}> {
  const projects: SyncedProject[] = []
  for (const project of getAppState().workspaces) {
    if (!validId(project.id)) throw new Error('Project has an invalid sync identity.')
    if (!existsSync(project.path))
      throw new Error(
        `Project “${project.name}” is unavailable. Reconnect its folder before syncing to preserve its chats.`
      )
    projects.push({
      id: project.id,
      name: project.name,
      repositoryUrl: repositoryFor(project),
      createdAt: project.createdAt,
      lastOpenedAt: project.lastOpenedAt,
      chats: await exportChats(project.path),
      skills: listSkills(project.path)
        .filter((s) => s.scope === 'workspace')
        .map(({ id, name, description, body }) => ({ id, name, description, body }))
    })
  }
  return { projects, chats: await exportChats(null) }
}
async function importChats(path: string | null, chats: ChatThread[]): Promise<number> {
  let imported = 0
  for (const chat of chats) {
    if (!validId(chat.id) || !Array.isArray(chat.messages) || (chat.messageOffset ?? 0) !== 0)
      throw new Error('Invalid remote chat transcript.')
    const existing = await getChat(path, chat.id)
    if (existing) {
      const portable = (thread: ChatThread) =>
        thread.messages.map(
          ({ id, role, content, thinking, createdAt, agentId, agentName, model }) => ({
            id,
            role,
            content,
            thinking,
            createdAt,
            agentId,
            agentName,
            model
          })
        )
      const localMessages = portable(existing),
        remoteMessages = portable(chat)
      const sameMessages = JSON.stringify(localMessages) === JSON.stringify(remoteMessages)
      if (
        sameMessages &&
        (existing.updatedAt >= chat.updatedAt ||
          (existing.title === chat.title && existing.model === chat.model))
      )
        continue
      const prefix = (first: typeof localMessages, second: typeof localMessages) =>
        first.length <= second.length &&
        first.every((m, i) => JSON.stringify(m) === JSON.stringify(second[i]))
      const remoteIsPrefix = prefix(remoteMessages, localMessages),
        localIsPrefix = prefix(localMessages, remoteMessages)
      // Preserve diverged histories as separate chats instead of losing either device's work.
      if (!sameMessages && !remoteIsPrefix && !localIsPrefix) {
        const conflict = existing.updatedAt >= chat.updatedAt ? chat : existing
        const suffix = createHash('sha256')
          .update(JSON.stringify(portable(conflict)))
          .digest('hex')
          .slice(0, 12)
        const conflictId = chat.id.slice(0, 70) + '-conflict-' + suffix
        if (!(await getChat(path, conflictId))) {
          await saveChat(path, {
            ...conflict,
            id: conflictId,
            title: conflict.title + ' (other device)',
            messageOffset: 0
          })
          imported++
        }
        if (conflict === chat) continue
      } else if (remoteIsPrefix && !sameMessages) continue
      else if (sameMessages && existing.updatedAt >= chat.updatedAt) continue
    }
    await saveChat(path, { ...chat, messageOffset: 0 })
    imported++
  }
  return imported
}
export async function importProfileWorkspaces(
  projects: SyncedProject[],
  chats: ChatThread[]
): Promise<{ projectsImported: number; chatsImported: number }> {
  const state = getAppState()
  const workspaces = [...state.workspaces]
  let projectsImported = 0
  let chatsImported = await importChats(null, chats)
  for (const project of projects) {
    if (!validId(project.id) || !Array.isArray(project.chats))
      throw new Error('Invalid remote project.')
    let local = workspaces.find((w) => w.id === project.id)
    if (!local) {
      const path = join(userDataRoot(), 'synced-projects', project.id)
      mkdirSync(join(path, '.eris'), { recursive: true })
      local = {
        id: project.id,
        name: project.name,
        path,
        createdAt: project.createdAt,
        lastOpenedAt: project.lastOpenedAt,
        repositoryUrl: portableRepositoryUrl(project.repositoryUrl),
        cloudRestored: true
      }
      workspaces.push(local)
      projectsImported++
      // Save the mapping first so an interrupted import can resume safely.
      setAppState({ workspaces })
    }
    local.name = project.name
    local.lastOpenedAt = Math.max(local.lastOpenedAt, project.lastOpenedAt)
    local.repositoryUrl = portableRepositoryUrl(project.repositoryUrl)
    chatsImported += await importChats(local.path, project.chats)
    for (const skill of project.skills || [])
      upsertSkill(local.path, { ...skill, scope: 'workspace' })
  }
  setAppState({ workspaces })
  return { projectsImported, chatsImported }
}
/** Remap a restored identity to a folder selected on this computer; keep its conversations. */
export async function attachRestoredProject(project: WorkspaceRecord, path: string): Promise<void> {
  if (project.path !== path) {
    await importChats(path, await exportChats(project.path))
    for (const skill of listSkills(project.path).filter((s) => s.scope === 'workspace'))
      upsertSkill(path, { ...skill, scope: 'workspace' })
  }
  mkdirSync(workspaceConfigDir(path), { recursive: true })
  const state = getAppState()
  setAppState({
    workspaces: state.workspaces.map((w) =>
      w.id === project.id ? { ...w, path, cloudRestored: false } : w
    )
  })
  // Record only portable repository metadata. Repository contents are managed by the user.
  writeFileSync(
    join(workspaceConfigDir(path), 'cloud-project.json'),
    JSON.stringify({ id: project.id, repositoryUrl: project.repositoryUrl || '' }),
    { mode: 0o600 }
  )
}
