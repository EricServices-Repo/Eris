import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, ChatThread, FileEntry, WorkspaceRecord } from '@/shared/settings-schema'
import type { OpenTab } from '@/features/editor/EditorArea'
import type { ActiveSkillRef } from '@/features/chat/ChatPanel'
import { joinWorkspacePath, pathBasename } from '@/shared/paths'
import type { RightPanel } from './useLayout'
import { forgetDocument, seedDocument, snapshotTab } from '@/state/documents'

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
  const [tabs, updateTabs] = useState<OpenTab[]>([])
  const setTabs: Dispatch<SetStateAction<OpenTab[]>> = useCallback((action) => {
    updateTabs((previous) => {
      const next = typeof action === 'function' ? action(previous) : action
      for (const tab of next) {
        const before = previous.find((entry) => entry.path === tab.path)
        if (!before || before.content !== tab.content || (before.dirty !== tab.dirty && !tab.dirty))
          seedDocument(tab)
      }
      const open = new Set(next.map((tab) => tab.path))
      for (const tab of previous) if (!open.has(tab.path)) forgetDocument(tab.path)
      return next
    })
  }, [])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const tabsRef = useRef<OpenTab[]>([])
  tabsRef.current = tabs
  const [revealLine, setRevealLine] = useState<number | null>(null)
  const [indexMentions, setIndexMentions] = useState<Array<{ path: string; name: string }>>([])
  const workspaceGeneration = useRef(0)
  const fileSelection = useRef(0)
  const treeRef = useRef(tree)
  treeRef.current = tree

  const persistMeta = useCallback(
    async (
      path: string,
      nextTabs: OpenTab[],
      nextActive: string | null,
      chatId: string | null,
      model: string
    ) => {
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
      const generation = ++workspaceGeneration.current
      fileSelection.current++
      const opened = await window.ide.openWorkspaceById(record.id)
      if (generation !== workspaceGeneration.current) return
      if (!opened) {
        await refreshWorkspaceList()
        return
      }
      setActiveWorkspace(opened)
      setTabs([])
      setActiveFile(null)
      // Interactive shell first: tree + meta + settings. Models/index come after paint.
      const [entries, list, meta, resolved] = await Promise.all([
        window.ide.listTree(opened.path),
        refreshWorkspaceList(),
        window.ide.getWorkspaceMeta(opened.path),
        refreshSettings()
      ])
      if (generation !== workspaceGeneration.current) return
      setTree(entries)
      setWorkspaces(list)
      setSettings(resolved)

      const restored: OpenTab[] = meta.openFiles.map((path) => ({
        path,
        name: pathBasename(path),
        content: '',
        language: 'plaintext',
        dirty: false,
        loaded: false
      }))
      const selected = restored.find((tab) => tab.path === meta.activeFile) ?? restored[0]
      if (selected) {
        try {
          const file = await window.ide.readFile(selected.path)
          Object.assign(selected, file, { loaded: true })
        } catch {
          restored.splice(restored.indexOf(selected), 1)
        }
      }
      if (generation !== workspaceGeneration.current) return
      setTabs(restored)
      setActiveFile(selected?.loaded ? selected.path : null)

      if (meta.lastModel) setSelectedModel(meta.lastModel)
      await refreshChats(meta.activeChatId)
      setActiveSkills([])

      // Defer provider probes / skills so the editor shell becomes interactive sooner.
      void refreshModels(resolved)
      void refreshSkills()
    },
    [
      refreshSettings,
      refreshModels,
      refreshChats,
      refreshWorkspaceList,
      refreshSkills,
      setSettings,
      setSelectedModel,
      setActiveSkills,
      setTabs
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
    [activeWorkspace?.id, loadWorkspace, setThreads, setActiveThread, setTabs]
  )

  const openFile = useCallback(
    async (path: string, line?: number) => {
      const selection = ++fileSelection.current
      const generation = workspaceGeneration.current
      const existing = tabsRef.current.find((t) => t.path === path)
      if (existing && existing.loaded !== false) {
        setActiveFile(path)
        if (line) setRevealLine(line)
        showRightPanel('editor')
        return
      }
      const file = await window.ide.readFile(path)
      if (generation !== workspaceGeneration.current) return
      if (existing && !tabsRef.current.some((tab) => tab.path === path)) return
      const loaded = { ...file, dirty: false, loaded: true }
      setTabs((previous) => {
        if (existing && !previous.some((tab) => tab.path === path)) return previous
        return previous.some((tab) => tab.path === path)
          ? previous.map((tab) => (tab.path === path ? loaded : tab))
          : [...previous, loaded]
      })
      if (selection !== fileSelection.current) return
      setActiveFile(path)
      if (line) setRevealLine(line)
      showRightPanel('editor')
    },
    [setTabs, showRightPanel]
  )

  useEffect(() => {
    if (tabs.some((tab) => tab.path === activeFile && tab.loaded === false))
      void openFile(activeFile!).catch(() => setActiveFile(null))
  }, [activeFile, tabs, openFile])

  const resolveWorkspacePath = useCallback(
    (path: string) => {
      if (!workspacePath) return path
      return joinWorkspacePath(workspacePath, path)
    },
    [workspacePath]
  )

  // Index @-mentions once per workspace — not on every tree rebuild (FS storms).
  useEffect(() => {
    if (!workspacePath) {
      setIndexMentions([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.ide
        .searchGlob('**/*.{ts,tsx,js,jsx,py,go,rs,md}')
        .then((r) => {
          if (cancelled) return
          setIndexMentions(
            (r.paths || []).slice(0, 200).map((path) => ({
              path,
              name: pathBasename(path)
            }))
          )
        })
        .catch(() => {
          if (!cancelled) setIndexMentions([])
        })
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [workspacePath])

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
    const selected = tabsRef.current.find((t) => t.path === activeFile)
    const tab = selected ? snapshotTab(selected) : null
    if (!tab || tab.loaded === false) return
    await window.ide.writeFile(tab.path, tab.content)
    setTabs((prev) =>
      prev.map((t) => (t.path === tab.path ? { ...t, content: tab.content, dirty: false } : t))
    )
  }, [activeFile, setTabs])

  useEffect(() => {
    if (!workspacePath) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let revision = 0
    const pending = new Set<string>()
    const off = window.ide.onWorkspaceFsChanged(({ workspacePath: root, paths, path }) => {
      if (root !== workspacePath) return
      for (const changed of paths?.length ? paths : [path]) pending.add(changed.replace(/\\/g, '/'))
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const current = ++revision
        const changes = [...pending]
        pending.clear()
        try {
          const previous = treeRef.current
          if (changes.some((changed) => !changed.includes('/'))) {
            const result = await window.ide.listTree(workspacePath, 0)
            if (current === revision)
              setTree(
                result.map((entry) => ({
                  ...entry,
                  children: entry.isDirectory
                    ? previous.find((old) => old.path === entry.path)?.children
                    : undefined
                }))
              )
          } else {
            const branches = new Set(changes.map((changed) => changed.split('/')[0]))
            const updates = await Promise.all(
              previous
                .filter(
                  (entry) =>
                    entry.isDirectory && entry.children !== undefined && branches.has(entry.name)
                )
                .map(async (entry) => ({
                  ...entry,
                  children: await window.ide.listTree(entry.path, 0)
                }))
            )
            if (current === revision)
              setTree((latest) =>
                latest.map((entry) => updates.find((update) => update.path === entry.path) ?? entry)
              )
          }
        } catch {
          /* A later watcher event retries inaccessible directories. */
        }
      }, 400)
    })
    return () => {
      if (timer) clearTimeout(timer)
      revision++
      off()
    }
  }, [workspacePath])

  useEffect(() => {
    if (!workspacePath) return
    const timer = setTimeout(() => {
      void persistMeta(workspacePath, tabs, activeFile, activeThreadId, selectedModel)
    }, 250)
    return () => clearTimeout(timer)
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
