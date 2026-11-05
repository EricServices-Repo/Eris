import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatThread } from '../src/shared/settings-schema'
const memory = vi.hoisted(() => new Map<string, Map<string, ChatThread>>())
vi.mock('../electron/main/services/chats', () => ({
  listChats: async (path: string | null) =>
    [...(memory.get(`${process.env.ERIS_TEST_APPDATA}:${path}`)?.values() || [])].map((c) => ({
      ...c,
      messages: []
    })),
  getChat: async (path: string | null, id: string) =>
    memory.get(`${process.env.ERIS_TEST_APPDATA}:${path}`)?.get(id) || null,
  saveChat: async (path: string | null, chat: ChatThread) => {
    const key = `${process.env.ERIS_TEST_APPDATA}:${path}`
    if (!memory.has(key)) memory.set(key, new Map())
    memory.get(key)!.set(chat.id, structuredClone(chat))
    return chat
  }
}))
import { saveChat, getChat } from '../electron/main/services/chats'
import { getAppState, setAppState } from '../electron/main/services/workspace'
import {
  exportProfileWorkspaces,
  importProfileWorkspaces,
  attachRestoredProject,
  portableRepositoryUrl
} from '../electron/main/services/profile-workspaces'
const chat: ChatThread = {
  id: 'chat-1',
  title: 'Resume coding',
  model: 'ollama:qwen',
  createdAt: 1,
  updatedAt: 2,
  messages: [{ id: 'msg-1', role: 'user', content: 'Continue this work', createdAt: 1 }]
}
describe('portable project profiles', () => {
  beforeEach(() => {
    memory.clear()
    process.env.ERIS_TEST_APPDATA = mkdtempSync(join(tmpdir(), 'eris-profile-'))
  })
  it('restores project identities and complete chats on another computer without syncing source paths', async () => {
    const path = join(process.env.ERIS_TEST_APPDATA!, 'source')
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(
      join(path, '.git', 'config'),
      '[remote "origin"]\n url = https://private-token@github.com/acme/app.git\n'
    )
    setAppState({
      workspaces: [{ id: 'project-1', name: 'My project', path, createdAt: 1, lastOpenedAt: 2 }]
    })
    await saveChat(path, chat)
    const exported = await exportProfileWorkspaces()
    expect(JSON.stringify(exported)).not.toContain(path)
    expect(exported.projects[0].repositoryUrl).toBe('https://github.com/acme/app.git')
    process.env.ERIS_TEST_APPDATA = mkdtempSync(join(tmpdir(), 'eris-second-device-'))
    const applied = await importProfileWorkspaces(exported.projects, exported.chats)
    expect(applied).toEqual({ projectsImported: 1, chatsImported: 1 })
    const restored = getAppState().workspaces[0]
    expect(restored.id).toBe('project-1')
    expect(restored.cloudRestored).toBe(true)
    expect((await getChat(restored.path, 'chat-1'))?.messages).toEqual(chat.messages)
    await importProfileWorkspaces(exported.projects, [])
    expect(getAppState().workspaces).toHaveLength(1)
    const checkout = mkdtempSync(join(tmpdir(), 'eris-checkout-'))
    await attachRestoredProject(restored, checkout)
    expect(getAppState().workspaces[0].path).toBe(checkout)
    expect(getAppState().workspaces[0].cloudRestored).toBe(false)
    expect((await getChat(checkout, 'chat-1'))?.messages).toEqual(chat.messages)
  })
  it('preserves newer local chats and refuses partial transcript uploads', async () => {
    const path = mkdtempSync(join(tmpdir(), 'eris-project-'))
    setAppState({
      workspaces: [{ id: 'project-1', name: 'Project', path, createdAt: 1, lastOpenedAt: 2 }]
    })
    await saveChat(path, { ...chat, updatedAt: 10, title: 'Newer local work' })
    await importProfileWorkspaces(
      [
        {
          id: 'project-1',
          name: 'Project',
          repositoryUrl: '',
          createdAt: 1,
          lastOpenedAt: 2,
          chats: [chat]
        }
      ],
      []
    )
    expect((await getChat(path, 'chat-1'))?.title).toBe('Newer local work')
    await saveChat(path, { ...chat, messageOffset: 5 })
    await expect(exportProfileWorkspaces()).rejects.toThrow('complete conversation')
  })
  it('keeps both histories when the same conversation diverges across computers', async () => {
    const path = mkdtempSync(join(tmpdir(), 'eris-diverged-'))
    setAppState({
      workspaces: [{ id: 'project-1', name: 'Project', path, createdAt: 1, lastOpenedAt: 2 }]
    })
    await saveChat(path, {
      ...chat,
      updatedAt: 10,
      messages: [
        ...chat.messages,
        { id: 'local-message', role: 'assistant', content: 'Local branch', createdAt: 10 }
      ]
    })
    await importProfileWorkspaces(
      [
        {
          id: 'project-1',
          name: 'Project',
          repositoryUrl: '',
          createdAt: 1,
          lastOpenedAt: 2,
          chats: [
            {
              ...chat,
              updatedAt: 5,
              messages: [
                ...chat.messages,
                { id: 'remote-message', role: 'assistant', content: 'Remote branch', createdAt: 5 }
              ]
            }
          ]
        }
      ],
      []
    )
    const exported = await exportProfileWorkspaces()
    expect(exported.projects[0].chats).toHaveLength(2)
    expect(JSON.stringify(exported.projects[0].chats)).toContain('Local branch')
    expect(JSON.stringify(exported.projects[0].chats)).toContain('Remote branch')
  })
  it('rejects traversal IDs and removes credentials from repository metadata', async () => {
    expect(portableRepositoryUrl('https://user:secret@github.com/org/repo?token=secret')).toBe(
      'https://github.com/org/repo'
    )
    await expect(
      importProfileWorkspaces(
        [
          {
            id: '../escape',
            name: 'bad',
            repositoryUrl: '',
            createdAt: 0,
            lastOpenedAt: 0,
            chats: []
          }
        ],
        []
      )
    ).rejects.toThrow('Invalid remote project')
  })
})
