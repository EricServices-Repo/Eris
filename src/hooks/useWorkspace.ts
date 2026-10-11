import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type {
  AppSettings,
  ChatThread,
  FileEntry,
  WorkspaceRecord
} from '@/shared/settings-schema'
import type { OpenTab } from '@/features/editor/EditorArea'
import type { ActiveSkillRef } from '@/features/chat/ChatPanel'
import type { RightPanel } from './useLayout'

export type UseWorkspaceDeps = {
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  refreshSettings: () => Promise<AppSettings>
  refreshModels: (resolved?: AppSettings) => Promise<void>
  selectedModel: string
  setSelectedModel: Dispatch<SetStateAction<string>>
  activeThreadId: string | null
  setThreads: Dispatch<SetStateAction<ChatThread[]>>
  setActiveThread: Dispatch<SetStateAction<ChatThread | null>>
  refreshChats: (preferredId?: string | null) => Promise<void>
  refreshSkills: () => Promise<void>
  setActiveSkills: Dispatch<SetStateAction<ActiveSkillRef[]>>
  showRightPanel: (panel: RightPanel) => void
}

export function useWorkspace({
  setSettings,
  refreshSettings,
  refreshModels,
  selectedModel,
  setSelectedModel,
  activeThreadId,
  setThreads,
  setActiveThread,
  refreshChats,
  refreshSkills,
  setActiveSkills,
  showRightPanel
}: UseWorkspaceDeps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRecord | null>(null)
  const workspacePath = activeWorkspace?.path ?? null
  const [tree, setTree] = useState<FileEntry[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const tabsRef = useRef<OpenTab[]>([])
  tabsRef.current = tabs
  const [revealLine, setRevealLine] = useState<number | null>(null)
  const [indexMentions, setIndexMentions] = useState<Array<{ path: string; name: string }>>([])

  const persistMeta = useCallback(
    async (path: string, nextTabs: OpenTab[], nextActive: string | null, chatId: string | null, model: string) => {
      await window.ide.setWorkspaceMeta(path, {
        openFiles: nextTabs.map((t) => t.path),
        activeFile: nextActive,
        activeChatId: chatId,
        lastModel: model || null
      })
    },
    []
  )

  const refreshWorkspaceList = useCallback(async () => {
    const list = await window.ide.listWorkspaces()
    setWorkspaces(list)
    return list
  }, [])

  const loadWorkspace = useCallback(
    async (record: WorkspaceRecord) => {
      const opened = await window.ide.openWorkspaceById(record.id)
      if (!opened) {
        await refreshWorkspaceList()
        return
      }
      setActiveWorkspace(opened)
      const [entries, list, meta, resolved] = await Promise.all([
        window.ide.listTree(opened.path),
        refreshWorkspaceList(),
        window.ide.getWorkspaceMeta(opened.path),
        refreshSettings()
      ])
      setTree(entries)
      setWorkspaces(list)
      setSettings(resolved)
      await refreshModels(resolved)

      const restored: OpenTab[] = []
      for (const filePath of meta.openFiles) {
        try {
          const file = await window.ide.readFile(filePath)
          restored.push({
            path: file.path,
            name: file.name,
            content: file.content,
            language: file.language,
            dirty: false
          })
        } catch {
          // skip missing
        }
      }
      setTabs(restored)
      setActiveFile(
        meta.activeFile && restored.some((t) => t.path === meta.activeFile)
          ? meta.activeFile
          : restored[0]?.path ?? null
      )

      if (meta.lastModel) setSelectedModel(meta.lastModel)
      await refreshChats(meta.activeChatId)
      await refreshSkills()
      setActiveSkills([])
    },
    [
      refreshSettings,
      refreshModels,
      refreshChats,
      refreshWorkspaceList,
      refreshSkills,
      setSettings,
      setSelectedModel,
      setActiveSkills
    ]
  )

  const activateWorkspaceRecord = useCallback(
    async (record: WorkspaceRecord | null) => {
      if (!record) return
      await loadWorkspace(record)
    },
    [loadWorkspace]
  )

  const linkFolder = useCallback(
    async (name?: string) => {
      const record = await window.ide.linkWorkspace(name || undefined)
      if (record) await loadWorkspace(record)
    },
    [loadWorkspace]
  )

  const createWorkspace = useCallback(
    async (name: string) => {
      const record = await window.ide.createWorkspace(name)
      if (record) await loadWorkspace(record)
    },
    [loadWorkspace]
  )

  const removeWorkspace = useCallback(
    async (id: string) => {
      const state = await window.ide.removeWorkspace(id)
      setWorkspaces(state.workspaces)
      if (activeWorkspace?.id === id) {
        setActiveWorkspace(null)
        setTree([])
        setTabs([])
        setActiveFile(null)
        setThreads([])
        setActiveThread(null)
        const next = state.workspaces[0]
        if (next) await loadWorkspace(next)
      }
    },
    [activeWorkspace?.id, loadWorkspace, setThreads, setActiveThread]
  )

  const openFile = useCallback(
    async (path: string, line?: number) => {
      const existing = tabs.find((t) => t.path === path)
      if (existing) {
        setActiveFile(path)
        if (line) setRevealLine(line)
        showRightPanel('editor')
        return
      }
      const file = await window.ide.readFile(path)
      const next = [
        ...tabs,
        {
          path: file.path,
          name: file.name,
          content: file.content,
          language: file.language,
          dirty: false
        }
      ]
      setTabs(next)
      setActiveFile(path)
      if (line) setRevealLine(line)
      showRightPanel('editor')
      if (workspacePath) {
        void persistMeta(workspacePath, next, path, activeThreadId, selectedModel)
      }
    },
    [tabs, workspacePath, activeThreadId, selectedModel, persistMeta, showRightPanel]
  )

  const resolveWorkspacePath = useCallback(
    (path: string) => {
      if (path.startsWith('/')) return path
      if (!workspacePath) return path
      return `${workspacePath}/${path.split(' → ')[0]}`
    },
    [workspacePath]
  )

  useEffect(() => {
    if (!workspacePath) {
      setIndexMentions([])
      return
    }
    void window.ide
      .searchGlob('**/*.{ts,tsx,js,jsx,py,go,rs,md}')
      .then((r) => {
        setIndexMentions(
          (r.paths || []).slice(0, 200).map((path) => ({
            path,
            name: path.split('/').pop() || path
          }))
        )
      })
      .catch(() => setIndexMentions([]))
  }, [workspacePath, tree])

  useEffect(() => {
    const onGoto = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; line: number }>).detail
      if (!detail?.path) return
      void openFile(resolveWorkspacePath(detail.path), detail.line)
    }
    window.addEventListener('eris:goto', onGoto)
    return () => window.removeEventListener('eris:goto', onGoto)
  }, [openFile, resolveWorkspacePath])

  const saveActive = useCallback(async () => {
    const tab = tabs.find((t) => t.path === activeFile)
    if (!tab) return
    await window.ide.writeFile(tab.path, tab.content)
    setTabs((prev) => prev.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)))
  }, [tabs, activeFile])

  useEffect(() => {
    if (!workspacePath) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.ide.onWorkspaceFsChanged(({ workspacePath: root }) => {
      if (root !== workspacePath) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void window.ide.listTree(workspacePath).then(setTree).catch(() => undefined)
        void window.ide.getDiagnostics().catch(() => undefined)
      }, 400)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [workspacePath])

  useEffect(() => {
    if (!workspacePath) return
    void persistMeta(workspacePath, tabs, activeFile, activeThreadId, selectedModel)
  }, [workspacePath, tabs, activeFile, activeThreadId, selectedModel, persistMeta])

  return {
    workspaces,
    setWorkspaces,
    activeWorkspace,
    setActiveWorkspace,
    workspacePath,
    tree,
    setTree,
    tabs,
    setTabs,
    tabsRef,
    activeFile,
    setActiveFile,
    revealLine,
    indexMentions,
    refreshWorkspaceList,
    loadWorkspace,
    activateWorkspaceRecord,
    linkFolder,
    createWorkspace,
    removeWorkspace,
    openFile,
    resolveWorkspacePath,
    saveActive
  }
}
