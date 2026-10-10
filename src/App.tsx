import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type {
  AppSettings,
  ChatThread,
  FileEntry,
  ModelInfo,
  ResolvedAgent,
  SkillRecord,
  WorkspaceRecord
} from '@/shared/settings-schema'
import { Sidebar } from '@/layout/Sidebar'
import { StatusBar } from '@/layout/StatusBar'
import { useColumnWidths } from '@/layout/useColumnResize'
import { EditorArea, type OpenTab } from '@/features/editor/EditorArea'
import {
  ChatPanel,
  MAX_QUEUED_MESSAGES,
  type ActiveSkillRef,
  type ChatAttachment,
  type ChatMode,
  type QueuedChatMessage
} from '@/features/chat/ChatPanel'
import { DiffReview, type PendingDiff } from '@/features/chat/DiffReview'
import { TerminalPanel } from '@/features/terminal/TerminalPanel'
import { GitPanel } from '@/features/git/GitPanel'
import { SearchPanel } from '@/features/search/SearchPanel'
import { DebugPanel } from '@/features/debug/DebugPanel'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { CommandPalette, type CommandItem } from '@/features/palette/CommandPalette'
import { CreateWorkspaceModal } from '@/features/workspace/CreateWorkspaceModal'
import { SetupWizard } from '@/features/onboarding/SetupWizard'
import logo from '@/assets/logo.png'

function flattenFiles(entries: FileEntry[], out: Array<{ path: string; name: string }> = []) {
  for (const e of entries) {
    if (e.isDirectory) {
      if (e.children) flattenFiles(e.children, out)
    } else {
      out.push({ path: e.path, name: e.name })
    }
  }
  return out
}

function uid(): string {
  return crypto.randomUUID()
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRecord | null>(null)
  const workspacePath = activeWorkspace?.path ?? null
  const [tree, setTree] = useState<FileEntry[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  settingsRef.current = settings
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<
    | 'general'
    | 'models'
    | 'usage'
    | 'agent'
    | 'subagents'
    | 'skills'
    | 'rules'
    | 'context'
    | 'mcp'
    | 'github'
    | 'editor'
    | 'workspace'
    | undefined
  >(undefined)
  const [startCreateSkill, setStartCreateSkill] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [workspaceModal, setWorkspaceModal] = useState<null | 'create' | 'link'>(null)
  const [showSetupWizard, setShowSetupWizard] = useState(false)
  const [onboardingReady, setOnboardingReady] = useState(false)

  const [threads, setThreads] = useState<ChatThread[]>([])
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [ollamaOk, setOllamaOk] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [thinkingBuffer, setThinkingBuffer] = useState('')
  const [answerBuffer, setAnswerBuffer] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [activeSkills, setActiveSkills] = useState<ActiveSkillRef[]>([])
  const [agents, setAgents] = useState<ResolvedAgent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | 'auto'>('auto')
  const [routeLabel, setRouteLabel] = useState<string | null>(null)
  const [composerReady, setComposerReady] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [toolActivity, setToolActivity] = useState<
    Array<{
      id: string
      name: string
      path?: string
      status: 'running' | 'ok' | 'error'
      detail: string
    }>
  >([])
  const [agentStatus, setAgentStatus] = useState<string | null>(null)
  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [messageQueue, setMessageQueue] = useState<QueuedChatMessage[]>([])
  const messageQueueRef = useRef<QueuedChatMessage[]>([])
  messageQueueRef.current = messageQueue
  const [pendingDiffs, setPendingDiffs] = useState<PendingDiff[]>([])
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null)
  const [rightPanel, setRightPanel] = useState<'editor' | 'terminal' | 'git' | 'debug'>('editor')
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try {
      return localStorage.getItem('eris.leftCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    try {
      return localStorage.getItem('eris.rightCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [searchOpen, setSearchOpen] = useState(false)
  const {
    leftWidth,
    rightWidth,
    resizing,
    onLeftResizePointerDown,
    onRightResizePointerDown,
    resetLeftWidth,
    resetRightWidth
  } = useColumnWidths()
  const [revealLine, setRevealLine] = useState<number | null>(null)
  const [breakpoints, setBreakpoints] = useState<
    Array<{ id: string; path: string; line: number; enabled: boolean }>
  >([])
  const [indexMentions, setIndexMentions] = useState<Array<{ path: string; name: string }>>([])
  const [terminalOut, setTerminalOut] = useState('')
  const requestIdRef = useRef<string | null>(null)
  const thinkingAcc = useRef('')
  const answerAcc = useRef('')
  const routeMetaRef = useRef<{ agentId?: string; agentName?: string; model?: string }>({})
  const activeThreadRef = useRef<ChatThread | null>(null)
  activeThreadRef.current = activeThread
  const tabsRef = useRef<OpenTab[]>([])
  tabsRef.current = tabs
  const paintRaf = useRef(0)
  /** Set when user clicks Stop — unlock UI immediately and skip queue drain. */
  const userStoppedRef = useRef(false)

  const stopChat = useCallback(() => {
    userStoppedRef.current = true
    setStreaming(false)
    setThinkingBuffer('')
    setAnswerBuffer('')
    setAgentStatus(null)
    requestIdRef.current = null
    void window.ide.stopChat()
  }, [])

  const schedulePaint = useCallback(() => {
    if (paintRaf.current) return
    paintRaf.current = requestAnimationFrame(() => {
      paintRaf.current = 0
      setThinkingBuffer(thinkingAcc.current)
      setAnswerBuffer(answerAcc.current)
    })
  }, [])

  const refreshSettings = useCallback(async () => {
    const resolved = await window.ide.getResolvedSettings()
    setSettings(resolved)
    return resolved
  }, [])

  const refreshModels = useCallback(async (resolved?: AppSettings) => {
    const [status, agentList] = await Promise.all([
      window.ide.modelsStatus(),
      window.ide.listAgents()
    ])
    const builtinReady = status.builtin?.some((b) => b.ready) ?? false
    setComposerReady(builtinReady)
    setOllamaOk(builtinReady || Boolean(status.models.some((m) => m.source === 'connection' && m.ready)))
    setModels(
      status.models.length > 0
        ? status.models
        : [
            {
              name: 'builtin:composer-lite',
              source: 'builtin' as const,
              ready: status.builtin?.some((b) => b.id === 'composer-lite' && b.ready) ?? false
            }
          ]
    )
    setAgents(agentList)
    const s = resolved ?? settings
    const preferred =
      s?.models.defaultModel ||
      status.models.find((m) => m.ready && m.source === 'connection')?.name ||
      status.models.find((m) => m.name === 'builtin:composer-lite' && m.ready)?.name ||
      status.models.find((m) => m.name.startsWith('builtin:') && m.ready)?.name ||
      status.models.find((m) => m.ready)?.name ||
      'builtin:composer-lite'
    setSelectedModel((prev) => {
      // Keep the session picker; only fill when empty or the prior model left the catalog.
      if (prev && status.models.some((m) => m.name === prev)) return prev
      if (s?.models.defaultModel && status.models.some((m) => m.name === s.models.defaultModel)) {
        return s.models.defaultModel
      }
      return preferred
    })
  }, [settings])

  const refreshChats = useCallback(async (preferredId?: string | null) => {
    const list = await window.ide.listChats()
    setThreads(list)
    if (preferredId) {
      const found = list.find((t) => t.id === preferredId) ?? null
      setActiveThread(found)
    } else if (list.length > 0) {
      setActiveThread((prev) => list.find((t) => t.id === prev?.id) ?? list[0])
    } else {
      setActiveThread(null)
    }
  }, [])

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

  const refreshSkills = useCallback(async () => {
    try {
      const list = await window.ide.listSkills()
      setSkills(list)
    } catch {
      setSkills([])
    }
  }, [])

  const openSettings = useCallback(
    (category?: typeof settingsCategory, createSkill = false) => {
      setSettingsCategory(category)
      setStartCreateSkill(createSkill)
      setSettingsOpen(true)
    },
    []
  )

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
    [refreshSettings, refreshModels, refreshChats, refreshWorkspaceList, refreshSkills]
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
    [activeWorkspace?.id, loadWorkspace]
  )

  useEffect(() => {
    try {
      localStorage.setItem('eris.leftCollapsed', leftCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [leftCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem('eris.rightCollapsed', rightCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [rightCollapsed])

  const showRightPanel = useCallback((panel: 'editor' | 'terminal' | 'git' | 'debug') => {
    setRightPanel(panel)
    setRightCollapsed(false)
  }, [])

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
        void persistMeta(workspacePath, next, path, activeThread?.id ?? null, selectedModel)
      }
    },
    [tabs, workspacePath, activeThread?.id, selectedModel, persistMeta, showRightPanel]
  )

  const resolveWorkspacePath = useCallback(
    (path: string) => {
      if (path.startsWith('/')) return path
      if (!workspacePath) return path
      return `${workspacePath}/${path.split(' → ')[0]}`
    },
    [workspacePath]
  )

  const refreshBreakpoints = useCallback(async () => {
    if (!workspacePath) {
      setBreakpoints([])
      return
    }
    setBreakpoints(await window.ide.debugListBreakpoints())
  }, [workspacePath])

  useEffect(() => {
    void refreshBreakpoints()
  }, [refreshBreakpoints])

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const saveActive = useCallback(async () => {
    const tab = tabs.find((t) => t.path === activeFile)
    if (!tab) return
    await window.ide.writeFile(tab.path, tab.content)
    setTabs((prev) => prev.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t)))
  }, [tabs, activeFile])

  const newChat = useCallback(async () => {
    setMessageQueue([])
    const model = selectedModel || settings?.models.defaultModel || ''
    const thread = await window.ide.createChat(model)
    await refreshChats(thread.id)
  }, [selectedModel, settings, refreshChats])

  const addAttachments = useCallback((files: ChatAttachment[]) => {
    setAttachments((prev) => {
      const next = [...prev]
      for (const file of files) {
        if (!next.some((a) => a.path === file.path)) next.push(file)
      }
      return next
    })
  }, [])

  const importFiles = useCallback(async () => {
    const paths = await window.ide.pickFiles()
    addAttachments(
      paths.map((path) => ({
        path,
        name: path.split('/').pop() || path
      }))
    )
  }, [addAttachments])

  const sendMessage = useCallback(
    async (text: string, files: ChatAttachment[], skillIds: string[] = []) => {
      if (streaming) return
      if (!settings) {
        setChatError('Settings are still loading. Wait a moment and try again.')
        return
      }
      setChatError(null)
      thinkingAcc.current = ''
      answerAcc.current = ''
      setThinkingBuffer('')
      setAnswerBuffer('')
      setToolActivity([])
      setAgentStatus(null)
      if (chatMode === 'agent') {
        setPendingDiffs([])
        setActiveCheckpointId(null)
      }

      try {
        const status = await window.ide.modelsStatus()
        const builtinReady = status.builtin?.some((b) => b.ready)
        const hasConnection = status.models.some((m) => m.source === 'connection' && m.ready)
        setComposerReady(Boolean(builtinReady))
        setOllamaOk(Boolean(builtinReady || hasConnection))

        let thread = activeThread
        if (!thread) {
          thread = await window.ide.createChat(
            selectedModel || settings.models.defaultModel || 'builtin:composer-lite'
          )
          setActiveThread(thread)
          setThreads((prev) => [thread!, ...prev.filter((t) => t.id !== thread!.id)])
        }

        const selected =
          selectedModel || settings.models.defaultModel || 'builtin:composer-lite'
        const turnPlan = await window.ide.planChatTurn({
          text,
          fileNames: files.map((f) => f.name),
          manualAgentId: selectedAgentId === 'auto' ? null : selectedAgentId,
          selectedModel: selected,
          mode: chatMode
        })
        const runModel = turnPlan.models.chat
        setRouteLabel(turnPlan.reason)
        routeMetaRef.current = {
          agentId: turnPlan.agentId,
          agentName: turnPlan.agentName,
          model: runModel
        }

        if (turnPlan.error) {
          setChatError(turnPlan.error)
          const displayContent =
            files.length > 0
              ? `${text}\n\nAttached: ${files.map((f) => f.name).join(', ')}`
              : text
          const saved = await window.ide.saveChat({
            ...thread,
            model: runModel,
            messages: [
              ...thread.messages,
              { id: uid(), role: 'user', content: displayContent, createdAt: Date.now() }
            ]
          })
          setActiveThread(saved)
          setThreads((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
          setAttachments([])
          setActiveSkills([])
          return
        }

        const modelInfo = status.models.find((m) => m.name === runModel)
        const cannotRunBuiltin =
          runModel.startsWith('builtin:') &&
          !(
            status.builtin?.some(
              (b) => (b.ref === runModel || b.id === runModel.replace(/^builtin:/, '')) && b.ready
            ) ?? false
          )
        const cannotRunExternal =
          !runModel.startsWith('builtin:') &&
          (!hasConnection || (modelInfo ? modelInfo.ready === false : !hasConnection))
        if (cannotRunBuiltin || cannotRunExternal) {
          setChatError(
            cannotRunExternal
              ? `Can’t reach model “${runModel}”. Is Ollama running? Open Settings → Models → Refresh, or run: ollama serve`
              : hasConnection
                ? `Model “${runModel}” isn’t installed. Download it in Settings → Models, or pick another model.`
                : 'No model ready. Connect Ollama (Settings → Models) or download Composer Lite.'
          )
          // Still persist the user turn so the chat isn’t empty
          const displayContent =
            files.length > 0
              ? `${text}\n\nAttached: ${files.map((f) => f.name).join(', ')}`
              : text
          const saved = await window.ide.saveChat({
            ...thread,
            model: runModel,
            messages: [
              ...thread.messages,
              { id: uid(), role: 'user', content: displayContent, createdAt: Date.now() }
            ]
          })
          setActiveThread(saved)
          setThreads((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
          setAttachments([])
          setActiveSkills([])
          return
        }

        const [rulesRaw, skillsPrompt, workspaceContextPin] = await Promise.all([
          window.ide.loadRules().catch(() => ''),
          skillIds.length > 0
            ? window.ide.loadSkillsPrompt(skillIds).catch(() => '')
            : Promise.resolve(''),
          window.ide.loadWorkspaceContextPin().catch(() => '')
        ])
        // Keep system context inside builtin 4k/8k windows (agent path is leaner).
        const lean = chatMode === 'agent'
        const rulesCap = lean ? 1800 : 6000
        const openCap = lean ? 2500 : 10000
        const importCap = lean ? 3000 : 16000
        const importMaxFiles = lean ? 2 : 8
        const historyCap = lean
          ? Math.min(12, settings.agent.maxHistoryMessages)
          : settings.agent.maxHistoryMessages
        const rules = rulesRaw.length > rulesCap ? `${rulesRaw.slice(0, rulesCap)}\n…` : rulesRaw
        const openTab = tabs.find((t) => t.path === activeFile)
        const agentList = agents.length ? agents : await window.ide.listAgents()
        const activeAgent = agentList.find((a) => a.id === turnPlan.agentId)
        const contextParts: string[] = [
          settings.agent.systemPrompt.slice(0, lean ? 1200 : 4000),
          activeAgent
            ? `You are the “${activeAgent.name}” ${activeAgent.role === 'orchestrator' ? 'orchestrator' : 'subagent'}.\n${activeAgent.systemPrompt.slice(0, lean ? 1500 : 6000)}`
            : `You are the “${turnPlan.agentName}” agent.`
        ].filter(Boolean)
        if (rules) contextParts.push(`Workspace rules:\n${rules}`)
        if (workspaceContextPin) {
          contextParts.push(
            workspaceContextPin.length > 900
              ? `${workspaceContextPin.slice(0, 900)}\n…`
              : workspaceContextPin
          )
        }
        if (skillsPrompt) {
          contextParts.push(
            `Active skills for this message (follow these instructions):\n${skillsPrompt.slice(0, lean ? 2500 : 12000)}`
          )
        }
        if (settings.agent.includeOpenFiles && openTab) {
          contextParts.push(
            `Active file: ${openTab.path}\n\`\`\`${openTab.language}\n${openTab.content.slice(0, openCap)}\n\`\`\``
          )
        }

        const importedBlocks: string[] = []
        for (const file of files.slice(0, importMaxFiles)) {
          try {
            const open = tabs.find((t) => t.path === file.path)
            if (open) {
              importedBlocks.push(
                `Imported file: ${open.path}\n\`\`\`${open.language}\n${open.content.slice(0, importCap)}\n\`\`\``
              )
            } else {
              const read = await window.ide.readFile(file.path)
              importedBlocks.push(
                `Imported file: ${read.path}\n\`\`\`${read.language}\n${read.content.slice(0, importCap)}\n\`\`\``
              )
            }
          } catch {
            importedBlocks.push(`Imported file: ${file.path}\n(Unable to read file)`)
          }
        }
        if (importedBlocks.length > 0) {
          contextParts.push(`User-imported files for this message:\n\n${importedBlocks.join('\n\n')}`)
        }

        const history = thread.messages
          .filter((m) => m.role !== 'system')
          .slice(-historyCap)

        const skillNames = skillIds
          .map((id) => skills.find((s) => s.id === id)?.name || id)
          .filter(Boolean)
        const extras = [
          files.length > 0 ? `Attached: ${files.map((f) => f.name).join(', ')}` : '',
          skillNames.length > 0 ? `Skills: ${skillNames.join(', ')}` : ''
        ].filter(Boolean)
        const displayContent = extras.length > 0 ? `${text}\n\n${extras.join('\n')}` : text

        const userMsg = {
          id: uid(),
          role: 'user' as const,
          content: displayContent,
          createdAt: Date.now()
        }
        const withUser: ChatThread = {
          ...thread,
          model: runModel,
          messages: [...thread.messages, userMsg]
        }
        const saved = await window.ide.saveChat(withUser)
        setActiveThread(saved)
        setThreads((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
        setAttachments([])
        setActiveSkills([])

        const requestId = uid()
        requestIdRef.current = requestId
        userStoppedRef.current = false
        thinkingAcc.current = ''
        answerAcc.current = ''
        setThinkingBuffer('')
        setAnswerBuffer('')
        setStreaming(true)

        const apiUserContent =
          files.length > 0
            ? `${text}\n\n(See system context for ${files.length} imported file(s).)`
            : text

        const messages = [
          { role: 'system' as const, content: contextParts.join('\n\n') },
          ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user' as const, content: apiUserContent }
        ]

        const ok = await window.ide.streamChat({
          requestId,
          model: runModel,
          agentId: turnPlan.agentId,
          messages,
          mode: chatMode,
          turnPlan
        })
        // Error path also emits chat:error; this covers a missed event
        if (!ok && requestIdRef.current === requestId) {
          setStreaming(false)
          requestIdRef.current = null
          setChatError(
            (prev) =>
              prev ||
              'Chat failed — check Settings → Models (see logs for details)'
          )
        }
      } catch (err) {
        setStreaming(false)
        requestIdRef.current = null
        setChatError(err instanceof Error ? err.message : 'Chat failed')
      }
    },
    [
      settings,
      activeThread,
      selectedModel,
      selectedAgentId,
      agents,
      tabs,
      activeFile,
      streaming,
      skills,
      chatMode
    ]
  )

  // When the active reply finishes, send the next queued message (FIFO, max 3).
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    const justFinished = wasStreamingRef.current && !streaming
    wasStreamingRef.current = streaming
    if (!justFinished) return
    if (userStoppedRef.current) {
      userStoppedRef.current = false
      return
    }
    const q = messageQueueRef.current
    if (q.length === 0) return
    const [next, ...rest] = q
    messageQueueRef.current = rest
    setMessageQueue(rest)
    void sendMessage(next!.text, next!.attachments, next!.skillIds)
  }, [streaming, sendMessage])

  useEffect(() => {
    const offThinking = window.ide.onChatThinking(({ requestId, chunk }) => {
      if (requestId !== requestIdRef.current) return
      thinkingAcc.current += chunk
      schedulePaint()
    })
    const offAnswer = window.ide.onChatAnswer(({ requestId, chunk }) => {
      if (requestId !== requestIdRef.current) return
      answerAcc.current += chunk
      schedulePaint()
    })
    const offRouted = window.ide.onChatRouted(
      ({ requestId, agentId, agentName, model, reason, toolsModel }) => {
        if (requestId !== requestIdRef.current) return
        routeMetaRef.current = { agentId, agentName, model }
        if (reason) setRouteLabel(reason)
        else if (agentName) {
          const tools =
            toolsModel && toolsModel !== model
              ? ` → ${toolsModel.replace(/^builtin:/, '')}`
              : ''
          setRouteLabel(`${agentName} · ${model.replace(/^builtin:/, '')}${tools}`)
        }
      }
    )
    const offTool = window.ide.onChatTool(({ requestId, tool }) => {
      if (requestId !== requestIdRef.current) return
      setToolActivity((prev) => {
        const idx = prev.findIndex((t) => t.id === tool.id)
        if (idx < 0) return [...prev, tool]
        const next = [...prev]
        next[idx] = tool
        return next
      })
    })
    const offDiff = window.ide.onChatDiff(({ requestId, diff }) => {
      if (requestId !== requestIdRef.current) return
      setActiveCheckpointId(diff.checkpointId)
      const autoKeep = Boolean(settingsRef.current?.agent.autoKeepDiffs)
      // Auto-keep: skip review UI entirely (edits are already on disk).
      if (autoKeep) return
      setPendingDiffs((prev) => [
        ...prev,
        {
          id: uid(),
          checkpointId: diff.checkpointId,
          opIndex: diff.opIndex,
          path: diff.path,
          before: diff.before,
          after: diff.after,
          op: diff.op,
          status: 'pending'
        }
      ])
      if (workspacePath) {
        const rel = diff.path.split(' → ')[0] || diff.path
        const abs = rel.startsWith('/') ? rel : `${workspacePath}/${rel}`
        void openFile(abs).catch(() => undefined)
      }
    })
    const offCheckpoint = window.ide.onChatCheckpoint(({ requestId, checkpointId }) => {
      if (requestId !== requestIdRef.current) return
      setActiveCheckpointId(checkpointId)
    })
    const offTerminal = window.ide.onChatTerminal(({ requestId, text }) => {
      if (requestId !== requestIdRef.current) return
      setRightCollapsed(false)
      setRightPanel('terminal')
      setTerminalOut((prev) => prev + text)
    })
    let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null
    const offWorkspaceChanged = window.ide.onChatWorkspaceChanged(({ requestId }) => {
      if (requestId !== requestIdRef.current) return
      void refreshSkills()
      if (!workspacePath) return
      // Debounce tree/tab reloads across rapid agent write rounds
      if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer)
      workspaceRefreshTimer = setTimeout(async () => {
        workspaceRefreshTimer = null
        const root = workspacePath
        if (!root || requestIdRef.current !== requestId) return
        try {
          setTree(await window.ide.listTree(root))
        } catch {
          // ignore refresh errors
        }
        const prev = tabsRef.current
        const updates: OpenTab[] = []
        let changed = false
        for (const tab of prev) {
          if (tab.dirty) {
            updates.push(tab)
            continue
          }
          try {
            const file = await window.ide.readFile(tab.path)
            if (file.content !== tab.content) {
              changed = true
              updates.push({ ...tab, content: file.content, dirty: false })
            } else {
              updates.push(tab)
            }
          } catch {
            changed = true
          }
        }
        if (changed) {
          setTabs(updates)
          setActiveFile((cur) =>
            cur && updates.some((t) => t.path === cur) ? cur : updates[0]?.path ?? null
          )
        }
      }, 400)
    })
    const offStatus = window.ide.onChatStatus(({ requestId, text }) => {
      if (requestId !== requestIdRef.current) return
      setAgentStatus(text)
    })
    const offModel = window.ide.onChatModel(({ requestId, model, agentId, agentName }) => {
      if (requestId !== requestIdRef.current) return
      routeMetaRef.current = {
        ...routeMetaRef.current,
        model,
        agentId: agentId ?? routeMetaRef.current.agentId,
        agentName: agentName ?? routeMetaRef.current.agentName
      }
      const name = agentName || routeMetaRef.current.agentName || 'Agent'
      const modelLabel =
        model === 'builtin:composer-lite'
          ? 'Composer Lite'
          : model === 'builtin:composer'
            ? 'Composer Full'
            : model
      setRouteLabel(`${name} · ${modelLabel}`)
    })
    const offDone = window.ide.onChatDone(async ({ requestId, aborted }) => {
      // Stop may have cleared requestIdRef already — still accept the matching done.
      if (requestIdRef.current && requestId !== requestIdRef.current) return
      if (paintRaf.current) {
        cancelAnimationFrame(paintRaf.current)
        paintRaf.current = 0
      }
      const content = answerAcc.current || thinkingAcc.current
      const thinking = thinkingAcc.current
      const threadId = activeThreadRef.current?.id
      const meta = routeMetaRef.current
      setStreaming(false)
      setThinkingBuffer('')
      setAnswerBuffer('')
      setAgentStatus(null)
      requestIdRef.current = null
      if (aborted) {
        userStoppedRef.current = true
        thinkingAcc.current = ''
        answerAcc.current = ''
        return
      }
      if (!content || !threadId) return
      const latest = (await window.ide.getChat(threadId)) ?? activeThreadRef.current
      if (!latest) return
      const already =
        latest.messages.length > 0 &&
        latest.messages[latest.messages.length - 1]?.role === 'assistant' &&
        latest.messages[latest.messages.length - 1]?.content === content
      if (already) {
        setActiveThread(latest)
        return
      }
      const merged: ChatThread = {
        ...latest,
        model: meta.model || latest.model,
        messages: [
          ...latest.messages,
          {
            id: uid(),
            role: 'assistant',
            content,
            thinking: thinking || undefined,
            createdAt: Date.now(),
            agentId: meta.agentId,
            agentName: meta.agentName,
            model: meta.model
          }
        ]
      }
      const saved = await window.ide.saveChat(merged)
      setActiveThread(saved)
      void refreshChats(saved.id)
    })
    const offError = window.ide.onChatError(({ requestId, error }) => {
      if (requestId !== requestIdRef.current) return
      setStreaming(false)
      setThinkingBuffer('')
      setAnswerBuffer('')
      setAgentStatus(null)
      setChatError(error)
      requestIdRef.current = null
    })
    return () => {
      if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer)
      offThinking()
      offAnswer()
      offRouted()
      offTool()
      offDiff()
      offCheckpoint()
      offTerminal()
      offWorkspaceChanged()
      offStatus()
      offModel()
      offDone()
      offError()
      if (paintRaf.current) cancelAnimationFrame(paintRaf.current)
    }
  }, [refreshChats, refreshSkills, workspacePath, schedulePaint, openFile])

  useEffect(() => {
    void (async () => {
      const [state, versionInfo] = await Promise.all([
        window.ide.getAppState(),
        window.ide.getAppVersion().catch(() => null)
      ])
      if (versionInfo?.version) setAppVersion(versionInfo.version)
      setWorkspaces(state.workspaces)
      const resolved = await refreshSettings()
      await refreshModels(resolved)
      await refreshSkills()
      const needsOnboarding = !state.onboardingCompletedAt
      setShowSetupWizard(needsOnboarding)
      setOnboardingReady(true)
      if (!needsOnboarding && resolved.general.restoreLastWorkspace && state.lastWorkspaceId) {
        const last = state.workspaces.find((w) => w.id === state.lastWorkspaceId)
        if (last) await loadWorkspace(last)
      }
    })()
  }, [])

  useEffect(() => {
    const offs = [
      window.ide.onMenu('menu:settings', () => openSettings()),
      window.ide.onMenu('menu:open-folder', () => setWorkspaceModal('link')),
      window.ide.onMenu('menu:new-workspace', () => setWorkspaceModal('create')),
      window.ide.onMenu('menu:save', () => void saveActive()),
      window.ide.onMenu('menu:command-palette', () => setPaletteOpen(true)),
      window.ide.onMenu('menu:new-chat', () => void newChat()),
      window.ide.onMenu('menu:stop-chat', () => stopChat())
    ]
    return () => offs.forEach((off) => off())
  }, [saveActive, newChat, openSettings, stopChat])

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
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSettings])

  useEffect(() => {
    if (!workspacePath) return
    void persistMeta(workspacePath, tabs, activeFile, activeThread?.id ?? null, selectedModel)
  }, [workspacePath, tabs, activeFile, activeThread?.id, selectedModel, persistMeta])

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: 'new-workspace',
        label: 'New Workspace…',
        shortcut: '⌘⇧N',
        run: () => setWorkspaceModal('create')
      },
      {
        id: 'link',
        label: 'Link Folder as Workspace…',
        shortcut: '⌘O',
        run: () => setWorkspaceModal('link')
      },
      { id: 'settings', label: 'Open Settings', shortcut: '⌘,', run: () => openSettings() },
      {
        id: 'skills',
        label: 'Open Skills Settings',
        run: () => openSettings('skills')
      },
      {
        id: 'create-skill',
        label: 'Create Skill…',
        run: () => openSettings('skills', true)
      },
      { id: 'save', label: 'Save File', shortcut: '⌘S', run: () => void saveActive() },
      { id: 'new-chat', label: 'New Agent Chat', shortcut: '⌘L', run: () => void newChat() },
      {
        id: 'refresh-models',
        label: 'Refresh Local Models',
        run: () => void refreshModels()
      },
      {
        id: 'stop',
        label: 'Stop Agent Generation',
        run: () => stopChat()
      },
      {
        id: 'rules',
        label: 'Open Rules Settings',
        run: () => openSettings('rules')
      },
      {
        id: 'context',
        label: 'Open Workspace Context',
        run: () => openSettings('context')
      },
      {
        id: 'github',
        label: 'Open GitHub Settings',
        run: () => openSettings('github')
      },
      {
        id: 'usage',
        label: 'Open Usage Settings',
        run: () => openSettings('usage')
      },
      {
        id: 'github-link',
        label: 'Link Workspace to GitHub Repo',
        run: () => {
          showRightPanel('git')
          openSettings('github')
        }
      },
      {
        id: 'toggle-left',
        label: 'Toggle Explorer Sidebar',
        run: () => setLeftCollapsed((v) => !v)
      },
      {
        id: 'toggle-right',
        label: 'Toggle Right Panel',
        run: () => setRightCollapsed((v) => !v)
      },
      {
        id: 'terminal',
        label: 'Toggle Terminal',
        shortcut: '⌘`',
        run: () => {
          setRightCollapsed(false)
          setRightPanel((p) => (p === 'terminal' ? 'editor' : 'terminal'))
        }
      },
      {
        id: 'git',
        label: 'Toggle Source Control',
        run: () => {
          setRightCollapsed(false)
          setRightPanel((p) => (p === 'git' ? 'editor' : 'git'))
        }
      },
      {
        id: 'search',
        label: 'Search in Files',
        shortcut: '⇧⌘F',
        run: () => {
          setRightCollapsed(false)
          setSearchOpen(true)
        }
      },
      {
        id: 'debug',
        label: 'Toggle Run & Debug',
        run: () => {
          setRightCollapsed(false)
          setRightPanel((p) => (p === 'debug' ? 'editor' : 'debug'))
        }
      },
      {
        id: 'verify',
        label: 'Run Verify (typecheck/tests)',
        run: () => {
          void (async () => {
            showRightPanel('terminal')
            setTerminalOut((prev) => `${prev}$ verify\n`)
            const r = await window.ide.runVerify()
            setTerminalOut((prev) => `${prev}${r.detail}\n`)
          })()
        }
      },
      {
        id: 'mode-ask',
        label: 'Chat Mode: Ask',
        run: () => setChatMode('ask')
      },
      {
        id: 'mode-agent',
        label: 'Chat Mode: Agent',
        run: () => setChatMode('agent')
      }
    ],
    [saveActive, newChat, refreshModels, openSettings, showRightPanel]
  )

  if (!settings || !onboardingReady) {
    return <div className="welcome">Loading Eris…</div>
  }

  return (
    <div className="app-shell">
      <SetupWizard
        open={showSetupWizard}
        hasWorkspace={Boolean(workspacePath)}
        onCreateWorkspace={() => setWorkspaceModal('create')}
        onLinkWorkspace={() => setWorkspaceModal('link')}
        onFinished={() => {
          setShowSetupWizard(false)
          void refreshSettings().then((resolved) => refreshModels(resolved))
          void refreshWorkspaceList()
        }}
      />
      <div className="titlebar">
        <div className="titlebar-brand">
          <img src={logo} alt="" className="titlebar-logo" draggable={false} />
          <span>Eris{activeWorkspace ? ` — ${activeWorkspace.name}` : ''}</span>
        </div>
        <div className="titlebar-actions">
          {workspacePath && (
            <>
              <button
                className="btn-ghost"
                title="Terminal"
                onClick={() => {
                  setRightCollapsed(false)
                  setRightPanel((p) => (p === 'terminal' ? 'editor' : 'terminal'))
                }}
              >
                Terminal
              </button>
              <button
                className="btn-ghost"
                title="Source Control"
                onClick={() => {
                  setRightCollapsed(false)
                  setRightPanel((p) => (p === 'git' ? 'editor' : 'git'))
                }}
              >
                Git
              </button>
            </>
          )}
          <button onClick={() => setPaletteOpen(true)}>Commands</button>
        </div>
      </div>
      <div className="workspace-body">
        <div
          className={`main-grid${leftCollapsed ? ' left-collapsed' : ''}${
            rightCollapsed ? ' right-collapsed' : ''
          }${resizing ? ' is-resizing' : ''}`}
          style={
            {
              '--sidebar-width': `${leftWidth}px`,
              '--editor-width': `${rightWidth}px`
            } as CSSProperties
          }
        >
          <Sidebar
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            tree={tree}
            activeFile={activeFile}
            threads={threads}
            activeThreadId={activeThread?.id ?? null}
            collapsed={leftCollapsed}
            onCollapsedChange={setLeftCollapsed}
            onResizePointerDown={leftCollapsed ? undefined : onLeftResizePointerDown}
            onResizeReset={resetLeftWidth}
            onCreateWorkspace={() => setWorkspaceModal('create')}
            onLinkWorkspace={() => setWorkspaceModal('link')}
            onSelectWorkspace={(id) => {
              const ws = workspaces.find((w) => w.id === id)
              if (ws) void activateWorkspaceRecord(ws)
            }}
            onRenameWorkspace={(id, name) =>
              void window.ide.renameWorkspace(id, name).then(async (updated) => {
                const list = await refreshWorkspaceList()
                if (updated && activeWorkspace?.id === id) {
                  setActiveWorkspace(updated)
                } else {
                  setWorkspaces(list)
                }
              })
            }
            onRemoveWorkspace={(id) => void removeWorkspace(id)}
            onOpenFile={(p) => void openFile(p)}
            onAttachFile={(path) =>
              addAttachments([{ path, name: path.split('/').pop() || path }])
            }
            onSelectThread={(id) => {
              const t = threads.find((x) => x.id === id) ?? null
              setActiveThread(t)
              setChatError(null)
            }}
            onNewChat={() => {
              setChatError(null)
              void newChat()
            }}
            onDeleteThread={(id) => {
              const wasActive = activeThread?.id === id
              void window.ide.deleteChat(id).then(async () => {
                const list = await window.ide.listChats()
                setThreads(list)
                if (wasActive) {
                  setActiveThread(list[0] ?? null)
                  setChatError(null)
                  setThinkingBuffer('')
                  setAnswerBuffer('')
                } else {
                  setActiveThread((prev) =>
                    prev && list.some((t) => t.id === prev.id) ? prev : list[0] ?? null
                  )
                }
              })
            }}
          />
          <div className="agent-center-wrap">
            {!workspacePath ? (
              <div className="welcome">
                <img src={logo} alt="Eris" className="welcome-logo" draggable={false} />
                <h1>Eris</h1>
                <div>Create a workspace or link a folder to get started.</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn btn-primary" onClick={() => setWorkspaceModal('create')}>
                    New Workspace
                  </button>
                  <button className="btn" onClick={() => setWorkspaceModal('link')}>
                    Link Folder
                  </button>
                </div>
              </div>
            ) : (
              <ChatPanel
                activeThread={activeThread}
                routeLabel={routeLabel}
                composerReady={composerReady}
                modelsOk={ollamaOk}
                streaming={streaming}
                thinkingBuffer={thinkingBuffer}
                answerBuffer={answerBuffer}
                chatError={chatError}
                agentStatus={agentStatus}
                toolActivity={toolActivity}
                openTabs={tabs.map((t) => ({ path: t.path, name: t.name }))}
                mentionFiles={[...flattenFiles(tree), ...indexMentions]}
                attachments={attachments}
                skills={skills}
                activeSkills={activeSkills}
                chatMode={chatMode}
                onChatModeChange={setChatMode}
                models={models}
                selectedModel={selectedModel}
                onModelChange={(model) => {
                  setSelectedModel(model)
                  void window.ide
                    .setSettings('user', { models: { defaultModel: model } })
                    .then(setSettings)
                }}
                onNewChat={() => {
                  setChatError(null)
                  setMessageQueue([])
                  void newChat()
                }}
                onSend={(text, files, skillIds) => void sendMessage(text, files, skillIds)}
                onStop={stopChat}
                queuedMessages={messageQueue}
                onQueueMessage={(text, files, skillIds) => {
                  setMessageQueue((prev) => {
                    if (prev.length >= MAX_QUEUED_MESSAGES) return prev
                    return [
                      ...prev,
                      { id: uid(), text, attachments: files, skillIds }
                    ]
                  })
                }}
                onRemoveQueued={(id) =>
                  setMessageQueue((prev) => prev.filter((q) => q.id !== id))
                }
                onAttachmentsChange={setAttachments}
                onActiveSkillsChange={setActiveSkills}
                onImportFiles={() => void importFiles()}
                onAttachOpenTab={(path) => {
                  const tab = tabs.find((t) => t.path === path)
                  if (tab) addAttachments([{ path: tab.path, name: tab.name }])
                }}
                onOpenPath={(path) => {
                  const abs =
                    workspacePath && !path.startsWith('/')
                      ? `${workspacePath}/${path}`
                      : path.split(' → ')[0]!
                  void openFile(abs)
                }}
                onOpenModelsSettings={() => openSettings('models')}
                onOpenSkillsSettings={() => {
                  void refreshSkills()
                  openSettings('skills')
                }}
                onCreateSkill={() => openSettings('skills', true)}
                onDismissError={() => setChatError(null)}
              />
            )}
          </div>
          <div className={`editor-rail${rightCollapsed ? ' is-collapsed' : ''}`}>
            {!rightCollapsed && (
              <div
                className="panel-resize-handle panel-resize-handle-start"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize right panel"
                title="Drag to resize · double-click to reset"
                onPointerDown={onRightResizePointerDown}
                onDoubleClick={resetRightWidth}
              />
            )}
            {rightCollapsed ? (
              <div className="icon-rail right-icon-rail" role="toolbar" aria-label="Right panel">
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'editor' ? ' active' : ''}`}
                  title="Editor"
                  aria-label="Editor"
                  onClick={() => showRightPanel('editor')}
                >
                  ⌁
                </button>
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'terminal' ? ' active' : ''}`}
                  title="Terminal"
                  aria-label="Terminal"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('terminal')}
                >
                  ⌴
                </button>
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'git' ? ' active' : ''}`}
                  title="Git"
                  aria-label="Git"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('git')}
                >
                  ⎇
                </button>
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'debug' ? ' active' : ''}`}
                  title="Debug"
                  aria-label="Debug"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('debug')}
                >
                  ▹
                </button>
                <div className="icon-rail-spacer" />
                <button
                  type="button"
                  className="icon-rail-btn collapse-toggle"
                  title="Expand right panel"
                  aria-label="Expand right panel"
                  onClick={() => setRightCollapsed(false)}
                >
                  ‹
                </button>
              </div>
            ) : null}
            {!rightCollapsed && (
              <div className="right-panel-tabs" role="tablist" aria-label="Right panel">
                {workspacePath ? (
                  <>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'editor'}
                      className={`right-panel-tab ${rightPanel === 'editor' ? 'active' : ''}`}
                      onClick={() => setRightPanel('editor')}
                    >
                      Editor
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'terminal'}
                      className={`right-panel-tab ${rightPanel === 'terminal' ? 'active' : ''}`}
                      onClick={() => setRightPanel('terminal')}
                    >
                      Terminal
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'git'}
                      className={`right-panel-tab ${rightPanel === 'git' ? 'active' : ''}`}
                      onClick={() => setRightPanel('git')}
                    >
                      Git
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'debug'}
                      className={`right-panel-tab ${rightPanel === 'debug' ? 'active' : ''}`}
                      onClick={() => setRightPanel('debug')}
                    >
                      Debug
                    </button>
                  </>
                ) : (
                  <span className="right-panel-tab active" style={{ flex: 1, cursor: 'default' }}>
                    Editor
                  </span>
                )}
                <button
                  type="button"
                  className="right-panel-tab right-panel-collapse"
                  title="Collapse right panel"
                  aria-label="Collapse right panel"
                  onClick={() => setRightCollapsed(true)}
                >
                  ›
                </button>
              </div>
            )}
            <div className={`right-panel-body${rightCollapsed ? ' is-hidden' : ''}`}>
              {searchOpen && (
                <SearchPanel
                  open
                  workspacePath={workspacePath}
                  onClose={() => setSearchOpen(false)}
                  onOpenPath={(path, line) => {
                    void openFile(resolveWorkspacePath(path), line)
                    setSearchOpen(false)
                  }}
                />
              )}
              {!workspacePath ? (
                <div className="editor-empty">Open a workspace to edit files.</div>
              ) : rightPanel === 'terminal' ? (
                <TerminalPanel
                  open
                  workspacePath={workspacePath}
                  onClose={() => showRightPanel('editor')}
                />
              ) : rightPanel === 'git' ? (
                <GitPanel
                  open
                  workspacePath={workspacePath}
                  onClose={() => showRightPanel('editor')}
                  onOpenGithubSettings={() => openSettings('github')}
                  onOpenPath={(path) => {
                    void openFile(resolveWorkspacePath(path))
                  }}
                />
              ) : rightPanel === 'debug' ? (
                <DebugPanel
                  open
                  workspacePath={workspacePath}
                  activeFile={activeFile}
                  onClose={() => showRightPanel('editor')}
                  onOpenPath={(path, line) => {
                    void openFile(resolveWorkspacePath(path), line)
                  }}
                />
              ) : (
                <EditorArea
                  tabs={tabs}
                  activePath={activeFile}
                  settings={settings!}
                  chatBusy={streaming}
                  revealLine={revealLine}
                  pendingPatch={
                    pendingDiffs.find(
                      (d) =>
                        d.status === 'pending' &&
                        activeFile &&
                        (activeFile.endsWith(d.path.split(' → ')[0] || '') ||
                          activeFile.endsWith('/' + (d.path.split(' → ')[0] || '')))
                    ) || null
                  }
                  breakpoints={breakpoints.map((b) => ({ path: b.path, line: b.line }))}
                  onAcceptPatch={(id) =>
                    setPendingDiffs((prev) =>
                      prev.map((d) => (d.id === id ? { ...d, status: 'kept' } : d))
                    )
                  }
                  onRejectPatch={(id) => {
                    void (async () => {
                      const target = pendingDiffs.find((d) => d.id === id)
                      if (!target) return
                      await window.ide.restoreCheckpointOp(target.checkpointId, target.opIndex)
                      setPendingDiffs((prev) =>
                        prev.map((d) => (d.id === id ? { ...d, status: 'undone' } : d))
                      )
                      if (activeFile) {
                        try {
                          const file = await window.ide.readFile(activeFile)
                          setTabs((prev) =>
                            prev.map((t) =>
                              t.path === activeFile
                                ? { ...t, content: file.content, dirty: false }
                                : t
                            )
                          )
                        } catch {
                          // ignore
                        }
                      }
                    })()
                  }}
                  onToggleBreakpoint={(path, line) => {
                    void (async () => {
                      const rel = workspacePath
                        ? path.startsWith(workspacePath)
                          ? path.slice(workspacePath.length + 1)
                          : path
                        : path
                      const existing = breakpoints.find((b) => b.path === rel && b.line === line)
                      const next = existing
                        ? breakpoints.filter((b) => b.id !== existing.id)
                        : [
                            ...breakpoints,
                            {
                              id: uid(),
                              path: rel,
                              line,
                              enabled: true
                            }
                          ]
                      setBreakpoints(await window.ide.debugSaveBreakpoints(next))
                    })()
                  }}
                  onSelect={setActiveFile}
                  onClose={(path) => {
                    setTabs((prev) => {
                      const next = prev.filter((t) => t.path !== path)
                      if (activeFile === path) setActiveFile(next[next.length - 1]?.path ?? null)
                      return next
                    })
                  }}
                  onChange={(path, content) => {
                    setTabs((prev) =>
                      prev.map((t) => (t.path === path ? { ...t, content, dirty: true } : t))
                    )
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {workspacePath && pendingDiffs.length > 0 && (
          <div className="bottom-drawer">
            <DiffReview
              diffs={pendingDiffs}
              onOpenPath={(path) => {
                const abs = path.startsWith('/')
                  ? path
                  : `${workspacePath}/${path.split(' → ')[0]}`
                void openFile(abs)
              }}
              onKeep={(id) =>
                setPendingDiffs((prev) =>
                  prev.map((d) => (d.id === id ? { ...d, status: 'kept' } : d))
                )
              }
              onKeepAll={() =>
                setPendingDiffs((prev) =>
                  prev.map((d) =>
                    d.status === 'pending' ? { ...d, status: 'kept' as const } : d
                  )
                )
              }
              autoKeepDiffs={Boolean(settings?.agent.autoKeepDiffs)}
              onAutoKeepDiffsChange={(enabled) => {
                void window.ide
                  .setSettings('user', { agent: { autoKeepDiffs: enabled } })
                  .then(setSettings)
                if (enabled) {
                  setPendingDiffs((prev) =>
                    prev.map((d) =>
                      d.status === 'pending' ? { ...d, status: 'kept' as const } : d
                    )
                  )
                }
              }}
              onDismiss={() => setPendingDiffs([])}
              onUndoFile={(id) => {
                void (async () => {
                  const target = pendingDiffs.find((d) => d.id === id)
                  if (!target || target.status !== 'pending') return
                  await window.ide.restoreCheckpointOp(target.checkpointId, target.opIndex)
                  setPendingDiffs((prev) =>
                    prev.map((d) => (d.id === id ? { ...d, status: 'undone' } : d))
                  )
                  setTree(await window.ide.listTree(workspacePath))
                  for (const t of tabsRef.current) {
                    try {
                      const file = await window.ide.readFile(t.path)
                      setTabs((prev) =>
                        prev.map((x) =>
                          x.path === t.path
                            ? { ...x, content: file.content, dirty: false }
                            : x
                        )
                      )
                    } catch {
                      // file may have been removed
                    }
                  }
                })()
              }}
              onUndoAll={() => {
                void (async () => {
                  if (!activeCheckpointId) return
                  await window.ide.restoreCheckpoint(activeCheckpointId)
                  setPendingDiffs((prev) =>
                    prev.map((d) => ({ ...d, status: 'undone' as const }))
                  )
                  setTree(await window.ide.listTree(workspacePath))
                  for (const t of tabsRef.current) {
                    try {
                      const file = await window.ide.readFile(t.path)
                      setTabs((prev) =>
                        prev.map((x) =>
                          x.path === t.path
                            ? { ...x, content: file.content, dirty: false }
                            : x
                        )
                      )
                    } catch {
                      // ignore
                    }
                  }
                })()
              }}
            />
          </div>
        )}
      </div>

      <StatusBar
        agents={agents}
        selectedAgentId={selectedAgentId}
        routeLabel={routeLabel}
        composerReady={composerReady}
        modelsOk={ollamaOk}
        appVersion={appVersion}
        disabled={!workspacePath}
        onOpenSettings={() => openSettings()}
        onAgentChange={setSelectedAgentId}
      />

      <SettingsModal
        open={settingsOpen}
        hasWorkspace={Boolean(workspacePath)}
        initialCategory={settingsCategory}
        startCreateSkill={startCreateSkill}
        onClose={() => {
          setSettingsOpen(false)
          setSettingsCategory(undefined)
          setStartCreateSkill(false)
          void refreshSkills()
        }}
        onChanged={(resolved) => {
          setSettings(resolved)
          void refreshModels(resolved)
          void refreshSkills()
        }}
        onRerunSetup={() => {
          void window.ide.resetOnboarding().then(() => setShowSetupWizard(true))
        }}
      />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <CreateWorkspaceModal
        open={workspaceModal !== null}
        mode={workspaceModal ?? 'create'}
        onClose={() => setWorkspaceModal(null)}
        onSubmit={(name) => {
          const mode = workspaceModal
          setWorkspaceModal(null)
          if (mode === 'create') void createWorkspace(name)
          else void linkFolder(name || undefined)
        }}
      />
    </div>
  )
}
