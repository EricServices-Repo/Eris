import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { AgentRunSummary } from '@/shared/api'
import type {
  AppSettings,
  ChatIntent,
  ChatThread,
  FileEntry,
  ModelInfo,
  SkillRecord
} from '@/shared/settings-schema'
import type { OpenTab } from '@/features/editor/EditorArea'
import type {
  ActiveSkillRef,
  ChatAttachment,
  ChatMode,
  PendingCommandApproval,
  QueuedChatMessage
} from '@/features/chat/ChatPanel'
import type { PendingDiff } from '@/features/chat/DiffReview'
import { joinWorkspacePath, pathBasename } from '@/shared/paths'
import type { RightPanel } from './useLayout'
import { uid } from './uid'

export type ToolActivityItem = {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  detail: string
}

export type UseChatSessionDeps = {
  settings: AppSettings | null
  settingsRef: MutableRefObject<AppSettings | null>
  selectedModel: string
  selectedAgentId: string | 'auto'
  /** In-memory catalog from useModels — avoids modelsStatus IPC on every send. */
  models: ModelInfo[]
  setComposerReady: Dispatch<SetStateAction<boolean>>
  setOllamaOk: Dispatch<SetStateAction<boolean>>
  skills: SkillRecord[]
  refreshSkills: () => Promise<void>
  setActiveSkills: Dispatch<SetStateAction<ActiveSkillRef[]>>
  activeThread: ChatThread | null
  setActiveThread: Dispatch<SetStateAction<ChatThread | null>>
  activeThreadRef: MutableRefObject<ChatThread | null>
  setThreads: Dispatch<SetStateAction<ChatThread[]>>
  refreshChats: (preferredId?: string | null) => Promise<void>
  workspacePath: string | null
  tabs: OpenTab[]
  tabsRef: MutableRefObject<OpenTab[]>
  setTabs: Dispatch<SetStateAction<OpenTab[]>>
  activeFile: string | null
  setActiveFile: Dispatch<SetStateAction<string | null>>
  setTree: Dispatch<SetStateAction<FileEntry[]>>
  openFile: (path: string, line?: number) => Promise<void>
  setRightPanel: Dispatch<SetStateAction<RightPanel>>
  setRightCollapsed: Dispatch<SetStateAction<boolean>>
  appendTerminal: (text: string) => void
}

export function useChatSession({
  settings,
  settingsRef,
  selectedModel,
  selectedAgentId,
  models,
  setComposerReady,
  setOllamaOk,
  skills,
  refreshSkills,
  setActiveSkills,
  activeThread,
  setActiveThread,
  activeThreadRef,
  setThreads,
  refreshChats,
  workspacePath,
  tabs,
  tabsRef,
  setTabs,
  activeFile,
  setActiveFile,
  setTree,
  openFile,
  setRightPanel,
  setRightCollapsed,
  appendTerminal
}: UseChatSessionDeps) {
  const [streaming, setStreaming] = useState(false)
  const [thinkingBuffer, setThinkingBuffer] = useState('')
  const [answerBuffer, setAnswerBuffer] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [routeLabel, setRouteLabel] = useState<string | null>(null)
  const [toolActivity, setToolActivity] = useState<ToolActivityItem[]>([])
  const [agentStatus, setAgentStatus] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingCommandApproval | null>(null)
  const [resumableRun, setResumableRun] = useState<AgentRunSummary | null>(null)
  const lastTurnRef = useRef<{ text: string; intent: ChatIntent; agentId: string } | null>(null)
  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [messageQueue, setMessageQueue] = useState<QueuedChatMessage[]>([])
  const messageQueueRef = useRef<QueuedChatMessage[]>([])
  messageQueueRef.current = messageQueue
  const [pendingDiffs, setPendingDiffs] = useState<PendingDiff[]>([])
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)
  /** Survives Stop so late chat:done/error still match the turn we aborted. */
  const lastRequestIdRef = useRef<string | null>(null)
  const thinkingAcc = useRef('')
  const answerAcc = useRef('')
  const routeMetaRef = useRef<{ agentId?: string; agentName?: string; model?: string }>({})
  const paintRaf = useRef(0)
  /** Set when user clicks Stop — unlock UI immediately and skip queue drain. */
  const userStoppedRef = useRef(false)

  const stopChat = useCallback(() => {
    userStoppedRef.current = true
    setStreaming(false)
    setAgentStatus(null)
    lastRequestIdRef.current = requestIdRef.current
    requestIdRef.current = null
    // Keep thinking/answer buffers visible until done flushes the partial reply.
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
        name: pathBasename(path)
      }))
    )
  }, [addAttachments])

  const sendMessage = useCallback(
    async (
      text: string,
      files: ChatAttachment[],
      skillIds: string[] = [],
      opts?: {
        forceRoute?: 'tools' | 'answer'
        resumeRunId?: string
        /** Use this thread instead of activeThread (reroute trims the last turn first) */
        thread?: ChatThread
      }
    ) => {
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
      // Paint Working immediately — don't wait on status/plan probes for first UI feedback.
      setAgentStatus('Working…')
      setStreaming(true)
      if (chatMode === 'agent') {
        setPendingDiffs([])
        setActiveCheckpointId(null)
      }

      const requestId = uid()
      requestIdRef.current = requestId
      lastRequestIdRef.current = requestId
      userStoppedRef.current = false

      try {
        // Prefer in-memory catalog from boot/refresh — no modelsStatus IPC on the hot path.
        let catalog = models
        if (catalog.length === 0) {
          const status = await window.ide.modelsStatus()
          catalog = status.models
        }
        const builtinReady = catalog.some((m) => m.source === 'builtin' && m.ready)
        const localReady = catalog.some((m) => m.source === 'local' && m.ready)
        const hasConnection = catalog.some((m) => m.source === 'connection' && m.ready)
        setComposerReady(builtinReady || localReady)
        setOllamaOk(builtinReady || localReady || hasConnection)

        let thread = opts?.thread ?? activeThread
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
          mode: chatMode,
          forceRoute: opts?.forceRoute
        })
        lastTurnRef.current = { text, intent: turnPlan.intent, agentId: turnPlan.agentId }
        const runModel = turnPlan.models.chat
        setRouteLabel(turnPlan.reason)
        routeMetaRef.current = {
          agentId: turnPlan.agentId,
          agentName: turnPlan.agentName,
          model: runModel
        }

        const abortUi = () => {
          if (requestIdRef.current === requestId || lastRequestIdRef.current === requestId) {
            setStreaming(false)
            setAgentStatus(null)
            requestIdRef.current = null
          }
        }

        if (turnPlan.error) {
          abortUi()
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

        const modelInfo = catalog.find((m) => m.name === runModel)
        const isLocalModel = runModel.startsWith('local:')
        const isBuiltinModel = runModel.startsWith('builtin:')
        const cannotRunLocal = isLocalModel && modelInfo?.ready !== true
        const cannotRunBuiltin = isBuiltinModel && modelInfo?.ready !== true
        const cannotRunExternal =
          !isLocalModel &&
          !isBuiltinModel &&
          (!hasConnection || (modelInfo ? modelInfo.ready === false : !hasConnection))
        if (cannotRunLocal || cannotRunBuiltin || cannotRunExternal) {
          abortUi()
          setChatError(
            cannotRunLocal
              ? `Local model “${runModel}” isn’t ready. Download it in Settings → Models → Local.`
              : cannotRunExternal
                ? `Can’t reach model “${runModel}”. Open Settings → Models, refresh your API/Ollama connection, or pick a Local model.`
                : hasConnection || localReady
                  ? `Model “${runModel}” isn’t installed. Download it in Settings → Models, or pick another model.`
                  : 'No model ready. Download a Local model or Composer Lite in Settings → Models.'
          )
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

        const openTab = tabs.find((t) => t.path === activeFile)
        const history = thread.messages.filter((m) => m.role !== 'system')

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
        // Optimistic paint + persist in parallel with stream start.
        setActiveThread(withUser)
        activeThreadRef.current = withUser
        setThreads((prev) => [withUser, ...prev.filter((t) => t.id !== withUser.id)])
        setAttachments([])
        setActiveSkills([])
        void window.ide.saveChat(withUser).then((saved) => {
          if (requestIdRef.current !== requestId && lastRequestIdRef.current !== requestId) return
          setActiveThread(saved)
          activeThreadRef.current = saved
          setThreads((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
        })

        thinkingAcc.current = ''
        answerAcc.current = ''
        setThinkingBuffer('')
        setAnswerBuffer('')

        const ok = await window.ide.streamChat({
          requestId,
          model: runModel,
          agentId: turnPlan.agentId,
          mode: turnPlan.mode,
          turnPlan,
          threadId: thread.id,
          prompt: {
            text,
            mode: turnPlan.mode,
            agentId: turnPlan.agentId,
            agentName: turnPlan.agentName,
            skillIds,
            openFile: openTab
              ? { path: openTab.path, language: openTab.language, content: openTab.content }
              : null,
            attachments: files.map((f) => {
              const open = tabs.find((t) => t.path === f.path)
              return open
                ? { path: f.path, name: f.name, language: open.language, content: open.content }
                : { path: f.path, name: f.name }
            }),
            history: history.map((m) => ({ role: m.role, content: m.content })),
            resumeRunId: opts?.resumeRunId
          }
        })
        if (!ok && requestIdRef.current === requestId) {
          setStreaming(false)
          setAgentStatus(null)
          requestIdRef.current = null
          setChatError(
            (prev) =>
              prev ||
              'Chat failed — check Settings → Models (see logs for details)'
          )
        }
      } catch (err) {
        setStreaming(false)
        setAgentStatus(null)
        requestIdRef.current = null
        setChatError(err instanceof Error ? err.message : 'Chat failed')
      }
    },
    [
      settings,
      activeThread,
      selectedModel,
      selectedAgentId,
      models,
      tabs,
      activeFile,
      streaming,
      skills,
      chatMode,
      setComposerReady,
      setOllamaOk,
      setActiveThread,
      activeThreadRef,
      setThreads,
      setActiveSkills
    ]
  )

  const rerouteLast = useCallback(
    async (route: 'tools' | 'answer') => {
      const thread = activeThreadRef.current
      if (!thread || streaming) return
      const idx = thread.messages.map((m) => m.role).lastIndexOf('user')
      if (idx < 0) return
      const lastUser = thread.messages[idx]!
      const text = lastTurnRef.current?.text ?? lastUser.content
      void window.ide.recordRoutingFeedback({
        text,
        from: lastTurnRef.current?.intent ?? 'answer',
        to: route,
        agentId: lastTurnRef.current?.agentId ?? ''
      })
      const trimmed = await window.ide.saveChat({
        ...thread,
        messages: thread.messages.slice(0, idx)
      })
      setActiveThread(trimmed)
      if (route === 'tools') setChatMode('agent')
      await sendMessage(text, [], [], { forceRoute: route, thread: trimmed })
    },
    [sendMessage, streaming, activeThreadRef, setActiveThread]
  )

  const refreshResumable = useCallback(async () => {
    if (!workspacePath) {
      setResumableRun(null)
      return
    }
    const run = await window.ide.getResumableRun().catch(() => null)
    setResumableRun(run)
  }, [workspacePath])

  useEffect(() => {
    if (!streaming) void refreshResumable()
  }, [streaming, refreshResumable])

  const resumeLastRun = useCallback(async () => {
    const run = resumableRun
    if (!run || streaming) return
    setResumableRun(null)
    setChatMode('agent')
    await sendMessage(`Resume: ${run.goal}`, [], [], {
      forceRoute: 'tools',
      resumeRunId: run.id
    })
  }, [resumableRun, sendMessage, streaming])

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
        void openFile(joinWorkspacePath(workspacePath, diff.path)).catch(() => undefined)
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
      appendTerminal(text)
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
    const offApproval = window.ide.onChatApprovalRequest(
      ({ requestId, approvalId, kind, command }) => {
        if (requestId !== requestIdRef.current) {
          void window.ide.respondCommandApproval(approvalId, 'deny')
          return
        }
        setPendingApproval({ approvalId, kind, command })
      }
    )
    const offApprovalResolved = window.ide.onChatApprovalResolved(({ approvalId }) => {
      setPendingApproval((cur) => (cur?.approvalId === approvalId ? null : cur))
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
          : model === 'builtin:composer' || model === 'composer'
            ? 'Composer Full'
            : model
      setRouteLabel(`${name} · ${modelLabel}`)
    })
    const offDone = window.ide.onChatDone(async ({ requestId, aborted }) => {
      const matches =
        requestId === requestIdRef.current || requestId === lastRequestIdRef.current
      if (!matches) return
      if (paintRaf.current) {
        cancelAnimationFrame(paintRaf.current)
        paintRaf.current = 0
      }
      const thinking = thinkingAcc.current
      let content = answerAcc.current
      if (!content && thinking && !aborted) content = thinking
      if (aborted) {
        if (content) {
          content = content.endsWith('\n')
            ? `${content}_(stopped)_`
            : `${content}\n\n_(stopped)_`
        } else if (thinking) {
          content = '_(stopped)_'
        }
      }
      const threadId = activeThreadRef.current?.id
      const meta = routeMetaRef.current
      setStreaming(false)
      setThinkingBuffer('')
      setAnswerBuffer('')
      setAgentStatus(null)
      setPendingApproval(null)
      requestIdRef.current = null
      if (aborted) userStoppedRef.current = true
      thinkingAcc.current = ''
      answerAcc.current = ''
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
      if (requestId !== requestIdRef.current && requestId !== lastRequestIdRef.current) return
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
      offApproval()
      offApprovalResolved()
      offModel()
      offDone()
      offError()
      if (paintRaf.current) cancelAnimationFrame(paintRaf.current)
    }
  }, [
    refreshChats,
    refreshSkills,
    workspacePath,
    schedulePaint,
    openFile,
    settingsRef,
    activeThreadRef,
    tabsRef,
    setActiveThread,
    setTree,
    setTabs,
    setActiveFile,
    setRightPanel,
    setRightCollapsed,
    appendTerminal
  ])

  return {
    streaming,
    thinkingBuffer,
    setThinkingBuffer,
    answerBuffer,
    setAnswerBuffer,
    chatError,
    setChatError,
    attachments,
    setAttachments,
    addAttachments,
    importFiles,
    routeLabel,
    toolActivity,
    agentStatus,
    setAgentStatus,
    pendingApproval,
    setPendingApproval,
    resumableRun,
    setResumableRun,
    chatMode,
    setChatMode,
    messageQueue,
    setMessageQueue,
    pendingDiffs,
    setPendingDiffs,
    activeCheckpointId,
    sendMessage,
    rerouteLast,
    resumeLastRun,
    stopChat,
    newChat
  }
}
