import { imagePromptFromCommand, type GeneratedImageAsset } from '@/shared/image-generation'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type {
  AppSettings,
  ChatDelegation,
  ChatIntent,
  ChatThread,
  ChatMessage,
  ModelInfo,
  SkillRecord
} from '@/shared/settings-schema'
import { promoteThinkingToAnswer, stripAnswerFromThinking } from '@/shared/posted-answer'
import type { OpenTab } from '@/features/editor/EditorArea'
import type {
  ActiveSkillRef,
  ChatAttachment,
  ChatMode,
  PendingCommandApproval,
  PendingUserQuestion,
  QueuedChatMessage
} from '@/features/chat/ChatPanel'
import type { PendingDiff } from '@/features/chat/DiffReview'
import { joinWorkspacePath, pathBasename } from '@/shared/paths'
import type { RightPanel } from './useLayout'
import { uid } from './uid'
import {
  chatStream,
  setThinkingBuffer,
  setAnswerBuffer,
  setToolActivity,
  setAgentStatus
} from '@/state/chat-stream'
import { snapshotTab } from '@/state/documents'
import { mergeChatTail } from '@/shared/chat-pages'

export type ToolActivityItem = {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  effect?: 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
  changedResources?: string[]
  durationMs?: number
  failure?: { code: string; retryable: boolean }
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
  tabsRef: MutableRefObject<OpenTab[]>
  setTabs: Dispatch<SetStateAction<OpenTab[]>>
  activeFile: string | null
  setActiveFile: Dispatch<SetStateAction<string | null>>
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
  tabsRef,
  setTabs,
  activeFile,
  setActiveFile,
  openFile,
  setRightPanel,
  setRightCollapsed,
  appendTerminal
}: UseChatSessionDeps) {
  const [streaming, setStreaming] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [routeLabel, setRouteLabel] = useState<string | null>(null)
  const [delegations, setDelegations] = useState<ChatDelegation[]>([])
  const delegationsRef = useRef<ChatDelegation[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<PendingCommandApproval[]>([])
  const pendingApproval = pendingApprovals[0]
    ? { ...pendingApprovals[0], queuedCount: pendingApprovals.length }
    : null
  const [pendingQuestion, setPendingQuestion] = useState<PendingUserQuestion | null>(null)
  const [memoryNotice, setMemoryNotice] = useState<{
    kind: 'updated' | 'proposal'
    preview: string
    note?: string
    summary?: string
  } | null>(null)
  const [liveSessionSteps, setLiveSessionSteps] = useState<
    Array<{ step: number; summary: string; opThrough: number }>
  >([])
  const lastTurnRef = useRef<{ text: string; intent: ChatIntent; agentId: string } | null>(null)
  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [messageQueue, setMessageQueue] = useState<QueuedChatMessage[]>([])
  const messageQueueRef = useRef<QueuedChatMessage[]>([])
  messageQueueRef.current = messageQueue
  const [pendingDiffs, setPendingDiffs] = useState<PendingDiff[]>([])
  const pendingDiffsRef = useRef(pendingDiffs)
  pendingDiffsRef.current = pendingDiffs
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null)
  const completedRequestsRef = useRef(new Set<string>())
  const requestIdRef = useRef<string | null>(null)
  /** Survives Stop so late chat:done/error still match the turn we aborted. */
  const lastRequestIdRef = useRef<string | null>(null)
  const requestThreadIdRef = useRef<string | null>(null)
  const requestWorkspacePathRef = useRef<string | null>(null)
  const thinkingAcc = useRef('')
  const answerAcc = useRef('')
  const imageAssetsRef = useRef<GeneratedImageAsset[]>([])
  const directImageRequestRef = useRef<string | null>(null)
  const routeMetaRef = useRef<{ agentId?: string; agentName?: string; model?: string }>({})
  const paintRaf = useRef(0)
  /** Set when user clicks Stop — unlock UI immediately and skip queue drain. */
  const userStoppedRef = useRef(false)
  const changedFiles = useRef(new Set<string>())

  const selectedLocalModelReady =
    (selectedModel.startsWith('local:') || selectedModel.startsWith('builtin:')) &&
    models.some((model) => model.name === selectedModel && model.ready === true)

  // A renderer reload should reconnect to the active main-process job instead of
  // presenting a manual recovery banner or silently losing its progress.
  useEffect(() => {
    let cancelled = false
    const selectedThread = activeThread?.id ?? null
    if (requestThreadIdRef.current !== selectedThread) {
      requestIdRef.current = null
      lastRequestIdRef.current = null
      answerAcc.current = ''
      thinkingAcc.current = ''
      setAnswerBuffer('')
      setThinkingBuffer('')
      setStreaming(false)
    }
    void window.ide
      .getLatestChatJob(selectedThread)
      .then(async (job) => {
        if (
          cancelled ||
          activeThreadRef.current?.id !== selectedThread ||
          !job ||
          job.workspacePath !== workspacePath
        )
          return
        if (job.persistenceError) setChatError(job.persistenceError)
        if (job.status !== 'running' && job.status !== 'queued') {
          if (
            job.threadId &&
            job.answer &&
            !activeThreadRef.current?.messages.some(
              (message) => message.id === `${job.id}:assistant`
            )
          ) {
            const saved = await window.ide.appendChatMessage(
              job.threadId,
              {
                id: `${job.id}:assistant`,
                role: 'assistant',
                content:
                  job.answer +
                  (job.status === 'stopped'
                    ? '\n\n_(stopped)_'
                    : job.status === 'incomplete'
                      ? '\n\n_(incomplete)_'
                      : ''),
                createdAt: Date.parse(job.updatedAt),
                model: job.model ?? undefined
              },
              job.model ?? undefined,
              job.workspacePath
            )
            if (!cancelled && activeThreadRef.current?.id === saved.id) {
              const merged = mergeChatTail(activeThreadRef.current, saved)
              activeThreadRef.current = merged
              setActiveThread(merged)
            }
          }
          return
        }
        if (
          cancelled ||
          !job ||
          (job.status !== 'running' && job.status !== 'queued') ||
          job.workspacePath !== workspacePath
        )
          return
        requestIdRef.current = job.id
        lastRequestIdRef.current = job.id
        requestThreadIdRef.current = job.threadId
        requestWorkspacePathRef.current = job.workspacePath
        answerAcc.current = job.answer
        thinkingAcc.current = ''
        const restoredTools = new Map<string, ToolActivityItem>()
        const restoredDiffs = new Map<string, PendingDiff>()
        let restoredCheckpoint: string | null = null
        for (const event of job.events) {
          if (event.channel === 'chat:tool' && event.payload.tool) {
            const tool = event.payload.tool as ToolActivityItem
            if (typeof tool.id === 'string') restoredTools.set(tool.id, tool)
          } else if (event.channel === 'chat:diff' && event.payload.diff) {
            const diff = event.payload.diff as {
              checkpointId: string
              opIndex: number
              path: string
              before: string | null
              after: string
              op: PendingDiff['op']
            }
            if (typeof diff.path === 'string' && typeof diff.checkpointId === 'string') {
              restoredCheckpoint = diff.checkpointId
              restoredDiffs.set(`${diff.checkpointId}:${diff.opIndex}:${diff.path}`, {
                id: `${job.id}:${diff.opIndex}:${diff.path}`,
                checkpointId: diff.checkpointId,
                opIndex: diff.opIndex,
                path: diff.path,
                before: diff.before,
                after: diff.after,
                op: diff.op,
                status: 'pending'
              })
            }
          } else if (event.channel === 'chat:checkpoint') {
            const checkpointId = event.payload.checkpointId
            if (typeof checkpointId === 'string') restoredCheckpoint = checkpointId
          } else if (event.channel === 'chat:model') {
            const model = event.payload.model
            if (typeof model === 'string') routeMetaRef.current.model = model
          } else if (event.channel === 'chat:routed') {
            const { agentId, agentName, model } = event.payload
            if (typeof agentId === 'string') routeMetaRef.current.agentId = agentId
            if (typeof agentName === 'string') routeMetaRef.current.agentName = agentName
            if (typeof model === 'string') routeMetaRef.current.model = model
          }
        }
        setToolActivity([...restoredTools.values()])
        for (const checkpointId of new Set(
          [...restoredDiffs.values()].map((d) => d.checkpointId)
        )) {
          const receipts = await window.ide.checkpointReview(checkpointId)
          for (const [key, diff] of restoredDiffs) {
            const receipt =
              diff.checkpointId === checkpointId
                ? receipts.find((r) => r.opIndex === diff.opIndex)
                : undefined
            if (receipt)
              restoredDiffs.set(key, {
                ...diff,
                status: receipt.status === 'conflicted' ? 'pending' : receipt.status,
                conflict: receipt.reason
              })
          }
        }
        if (cancelled || requestIdRef.current !== job.id) return
        setPendingDiffs([...restoredDiffs.values()])
        setActiveCheckpointId(restoredCheckpoint)
        setAnswerBuffer(job.answer)
        setThinkingBuffer('')
        setAgentStatus(job.statusText || 'Working…')
        setStreaming(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeThread?.id, activeThreadRef, setActiveThread, settingsRef, workspacePath])

  useEffect(() => {
    if (streaming || !selectedLocalModelReady) return
    const timer = window.setTimeout(() => {
      void window.ide.warmLocalModel(selectedModel)
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [selectedModel, selectedLocalModelReady, streaming])

  const stopChat = useCallback(() => {
    userStoppedRef.current = true
    setStreaming(false)
    setAgentStatus(null)
    setPendingQuestion(null)
    lastRequestIdRef.current = requestIdRef.current
    requestIdRef.current = null
    // Keep thinking/answer buffers visible until done flushes the partial reply.
    if (directImageRequestRef.current)
      void window.ide.cancelImageGeneration(directImageRequestRef.current)
    void window.ide.stopChat(lastRequestIdRef.current ?? undefined)
  }, [])

  const schedulePaint = useCallback(() => {
    if (paintRaf.current) return
    paintRaf.current = requestAnimationFrame(() => {
      paintRaf.current = 0
      chatStream.set((previous) => ({
        ...previous,
        thinkingBuffer: thinkingAcc.current,
        answerBuffer: answerAcc.current
      }))
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
      changedFiles.current.clear()
      thinkingAcc.current = ''
      answerAcc.current = ''
      imageAssetsRef.current = []
      setThinkingBuffer('')
      setAnswerBuffer('')
      setToolActivity([])
      delegationsRef.current = []
      setDelegations([])
      setPendingQuestion(null)
      setLiveSessionSteps([])
      // Paint Working immediately — don't wait on status/plan probes for first UI feedback.
      setAgentStatus('Working…')
      setStreaming(true)
      if (chatMode === 'agent') {
        setPendingDiffs([])
        setActiveCheckpointId(null)
      }

      const requestId = uid()
      requestIdRef.current = requestId
      requestThreadIdRef.current = null
      requestWorkspacePathRef.current = workspacePath
      lastRequestIdRef.current = requestId
      userStoppedRef.current = false

      try {
        const imagePrompt = imagePromptFromCommand(text)
        if (imagePrompt !== null) {
          if (!imagePrompt) throw new Error('Use /image followed by a description of the image.')
          if (files.length || skillIds.length)
            throw new Error(
              '/image currently accepts a text prompt. Remove attachments and skills to generate an image.'
            )
          let thread = opts?.thread ?? activeThread
          if (!thread)
            thread = await window.ide.createChat(selectedModel || settings.models.defaultModel)
          requestThreadIdRef.current = thread.id
          const userSaved = await window.ide.appendChatMessage(
            thread.id,
            {
              id: uid(),
              role: 'user',
              content: text,
              createdAt: Date.now()
            },
            undefined,
            workspacePath
          )
          setActiveThread(userSaved)
          activeThreadRef.current = userSaved
          setThreads((previous) => [
            userSaved,
            ...previous.filter((item) => item.id !== userSaved.id)
          ])
          setAttachments([])
          setActiveSkills([])
          setRouteLabel('Image generation')
          setAgentStatus('Generating image…')
          directImageRequestRef.current = requestId
          try {
            // Stop may have been clicked while the user message was being saved.
            if (userStoppedRef.current) return
            const result = await window.ide.generateImage({ requestId, prompt: imagePrompt })
            if (!result.ok) {
              if (!result.aborted) throw new Error(result.error)
              return
            }
            const saved = await window.ide.appendChatMessage(
              thread.id,
              {
                id: `${requestId}:assistant`,
                role: 'assistant',
                content: 'Generated image.',
                assets: [result.asset],
                model: result.asset.model,
                agentName: 'Image generation',
                createdAt: Date.now()
              },
              undefined,
              workspacePath
            )
            if (activeThreadRef.current?.id === saved.id) {
              const merged = mergeChatTail(activeThreadRef.current, saved)
              setActiveThread(merged)
              activeThreadRef.current = merged
            }
            setThreads((previous) => [saved, ...previous.filter((item) => item.id !== saved.id)])
          } finally {
            if (directImageRequestRef.current === requestId) directImageRequestRef.current = null
            if (requestIdRef.current === requestId || lastRequestIdRef.current === requestId) {
              requestIdRef.current = null
              setStreaming(false)
              setAgentStatus(null)
            }
          }
          return
        }
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
        requestThreadIdRef.current = thread.id

        const selected = selectedModel || settings.models.defaultModel || 'builtin:composer-lite'
        const runModel = selected
        lastTurnRef.current = { text, intent: 'answer', agentId: selectedAgentId }
        setRouteLabel('Resolving task and project…')
        routeMetaRef.current = {
          agentId: selectedAgentId,
          agentName: 'Resolving…',
          model: selected
        }

        const selectedTab = tabsRef.current.find((t) => t.path === activeFile)
        const openTab =
          selectedTab && selectedTab.loaded !== false ? snapshotTab(selectedTab) : undefined
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
        void window.ide
          .appendChatMessage(thread.id, userMsg, runModel, workspacePath)
          .then((saved) => {
            if (requestIdRef.current !== requestId && lastRequestIdRef.current !== requestId) return
            if (activeThreadRef.current?.id === saved.id) {
              const merged = mergeChatTail(activeThreadRef.current, saved)
              setActiveThread(merged)
              activeThreadRef.current = merged
            }
            setThreads((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
          })
          .catch((error) => setChatError(`Could not save your message: ${String(error)}`))

        thinkingAcc.current = ''
        answerAcc.current = ''
        setThinkingBuffer('')
        setAnswerBuffer('')

        const ok = await window.ide.streamChat({
          requestId,
          model: runModel,
          agentId: selectedAgentId === 'auto' ? undefined : selectedAgentId,
          mode: chatMode,
          forceRoute: opts?.forceRoute,
          workspacePath,
          threadId: thread.id,
          prompt: {
            text,
            mode: chatMode,
            agentId: selectedAgentId,

            skillIds,
            openFile: openTab
              ? { path: openTab.path, language: openTab.language, content: openTab.content }
              : null,
            attachments: files.map((f) => {
              const tab = tabsRef.current.find((t) => t.path === f.path)
              const open = tab && tab.loaded !== false ? snapshotTab(tab) : undefined
              return open
                ? { path: f.path, name: f.name, language: open.language, content: open.content }
                : { path: f.path, name: f.name }
            }),
            history: history.map((m) => ({
              role: m.role,
              content: m.content,
              agentId: m.agentId,
              agentName: m.agentName
            })),
            threadId: thread.id
          }
        })
        if (!ok && requestIdRef.current === requestId) {
          setStreaming(false)
          setAgentStatus(null)
          requestIdRef.current = null
          setChatError(
            (prev) => prev || 'Chat failed — check Settings → Models (see logs for details)'
          )
        }
      } catch (err) {
        if (lastRequestIdRef.current !== requestId) return
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
      tabsRef,
      activeFile,
      streaming,
      skills,
      chatMode,
      setComposerReady,
      setOllamaOk,
      setActiveThread,
      activeThreadRef,
      setThreads,
      setActiveSkills,
      workspacePath
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
    const offAsset = window.ide.onChatAsset(({ requestId, asset }) => {
      if (requestId !== requestIdRef.current) return
      if (!imageAssetsRef.current.some((item) => item.id === asset.id))
        imageAssetsRef.current.push(asset)
    })
    const offImageProgress = window.ide.onImageProgress(({ requestId, stage, detail }) => {
      if (requestId !== requestIdRef.current) return
      setAgentStatus(
        detail ??
          (stage === 'saving'
            ? 'Saving image…'
            : stage === 'complete'
              ? 'Image ready'
              : 'Generating image…')
      )
    })
    const offThinking = window.ide.onChatThinking(({ requestId, chunk }) => {
      if (requestId !== requestIdRef.current) return
      thinkingAcc.current += chunk
      schedulePaint()
    })
    const offAnswer = window.ide.onChatAnswer(({ requestId, chunk, replace }) => {
      if (requestId !== requestIdRef.current) return
      answerAcc.current = replace ? chunk : answerAcc.current + chunk
      schedulePaint()
    })
    const offRouted = window.ide.onChatRouted(
      ({ requestId, agentId, agentName, model, reason, toolsModel, task, intent }) => {
        if (requestId !== requestIdRef.current) return
        routeMetaRef.current = { agentId, agentName, model }
        if (lastTurnRef.current && intent)
          lastTurnRef.current = {
            ...lastTurnRef.current,
            intent: intent as ChatIntent,
            agentId: agentId ?? ''
          }
        if (task)
          setRouteLabel(
            `${task.deliverable} · ${task.scope.projectRoot?.split(/[\\/]/).pop() || 'Project unresolved'} · ${task.authority.edit ? 'Changes allowed' : 'Read only'}`
          )
        else if (reason) setRouteLabel(reason)
        else if (agentName) {
          const tools =
            toolsModel && toolsModel !== model ? ` → ${toolsModel.replace(/^builtin:/, '')}` : ''
          setRouteLabel(`${agentName} · ${model.replace(/^builtin:/, '')}${tools}`)
        }
      }
    )
    const offDelegation = window.ide.onChatDelegation(({ requestId, delegation }) => {
      if (requestId !== requestIdRef.current) return
      const prev = delegationsRef.current
      const idx = prev.findIndex((item) => item.id === delegation.id)
      const next =
        idx < 0 ? [...prev, delegation] : prev.map((item, i) => (i === idx ? delegation : item))
      delegationsRef.current = next
      setDelegations(next)
    })
    const offTool = window.ide.onChatTool(({ requestId, tool }) => {
      if (requestId !== requestIdRef.current) return
      if (tool.status === 'ok' && tool.effect === 'workspace') {
        for (const path of tool.changedResources?.length
          ? tool.changedResources
          : tool.path
            ? [tool.path]
            : [])
          changedFiles.current.add(path.replace(/\\/g, '/'))
      }
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
      for (const path of diff.path.split(' → ')) changedFiles.current.add(path.replace(/\\/g, '/'))
      setActiveCheckpointId(diff.checkpointId)
      const autoKeep = Boolean(settingsRef.current?.agent.autoKeepDiffs)
      // Auto-keep: skip review UI entirely (edits are already on disk).
      if (autoKeep) {
        void window.ide
          .decideCheckpointReview({
            checkpointId: diff.checkpointId,
            opIndices: [diff.opIndex],
            decision: 'keep'
          })
          .catch((error) => {
            if (requestId === requestIdRef.current) setChatError(String(error))
          })
        return
      }
      setPendingDiffs((prev) => [
        ...prev.filter((d) => d.checkpointId !== diff.checkpointId || d.opIndex !== diff.opIndex),
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
      if (workspacePath && diff.op !== 'binary') {
        void openFile(joinWorkspacePath(workspacePath, diff.path)).catch(() => undefined)
      }
    })
    const offCheckpoint = window.ide.onChatCheckpoint(({ requestId, checkpointId }) => {
      if (requestId !== requestIdRef.current) return
      setActiveCheckpointId(checkpointId)
    })
    const offSessionStep = window.ide.onChatSessionStep(
      ({ requestId, step, summary, opThrough }) => {
        if (requestId !== requestIdRef.current) return
        setLiveSessionSteps((prev) => {
          const next = prev.filter((s) => s.step !== step)
          next.push({ step, summary, opThrough })
          return next.sort((a, b) => a.step - b.step)
        })
      }
    )
    const offTerminal = window.ide.onChatTerminal(({ requestId, text }) => {
      if (requestId !== requestIdRef.current) return
      setRightCollapsed(false)
      setRightPanel('terminal')
      appendTerminal(text)
    })
    let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null
    const offWorkspaceChanged = window.ide.onChatWorkspaceChanged(({ requestId }) => {
      if (requestId !== requestIdRef.current) return
      if ([...changedFiles.current].some((path) => path.includes('.eris/skills/')))
        void refreshSkills()
      if (!workspacePath) return
      // Debounce tree/tab reloads across rapid agent write rounds
      if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer)
      workspaceRefreshTimer = setTimeout(async () => {
        workspaceRefreshTimer = null
        const root = workspacePath
        if (!root || requestIdRef.current !== requestId) return
        // The workspace watcher owns tree reconciliation. Only touched open
        // documents reload here, preserving pending previews and dirty text.
        const touched = [...changedFiles.current]
        changedFiles.current.clear()
        const prev = tabsRef.current
        const updates: OpenTab[] = []
        let changed = false
        for (const tab of prev) {
          const normalized = tab.path.replace(/\\/g, '/')
          if (
            tab.dirty ||
            tab.loaded === false ||
            !touched.some((path) => normalized === path || normalized.endsWith('/' + path))
          ) {
            updates.push(tab)
            continue
          }
          const held = pendingDiffsRef.current.some((diff) => {
            if (diff.status !== 'pending') return false
            const path = diff.path.split(' → ')[0] || ''
            return tab.path === path || tab.path.endsWith('/' + path) || tab.path.endsWith(path)
          })
          if (held) {
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
            cur && updates.some((t) => t.path === cur) ? cur : (updates[0]?.path ?? null)
          )
        }
      }, 400)
    })
    const offStatus = window.ide.onChatStatus(({ requestId, text }) => {
      if (requestId !== requestIdRef.current) return
      setAgentStatus(text)
    })
    const offApproval = window.ide.onChatApprovalRequest(
      ({ requestId, approvalId, kind, command, toolName, canAlwaysAllow }) => {
        if (requestId !== requestIdRef.current && kind !== 'mcp') {
          void window.ide.respondCommandApproval(approvalId, 'deny')
          return
        }
        setPendingApprovals((current) =>
          current.some((approval) => approval.approvalId === approvalId)
            ? current
            : [...current, { approvalId, kind, command, toolName, canAlwaysAllow }]
        )
      }
    )
    const offApprovalResolved = window.ide.onChatApprovalResolved(({ approvalId }) => {
      setPendingApprovals((current) =>
        current.filter((approval) => approval.approvalId !== approvalId)
      )
    })
    const offQuestion = window.ide.onChatQuestionRequest(
      ({ requestId, questionId, question, choices, timeoutMs }) => {
        if (requestId !== requestIdRef.current) {
          void window.ide.respondUserQuestion(questionId, null)
          return
        }
        setPendingQuestion({ questionId, question, choices, timeoutMs })
      }
    )
    const offQuestionResolved = window.ide.onChatQuestionResolved(({ questionId }) => {
      setPendingQuestion((cur) => (cur?.questionId === questionId ? null : cur))
    })
    const offMemoryUpdated = window.ide.onChatMemoryUpdated(({ preview }) => {
      setMemoryNotice({ kind: 'updated', preview })
    })
    const offMemoryProposal = window.ide.onChatMemoryProposal(({ preview, note, summary }) => {
      setMemoryNotice({ kind: 'proposal', preview, note, summary })
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
      const matches = requestId === requestIdRef.current || requestId === lastRequestIdRef.current
      if (!matches || completedRequestsRef.current.has(requestId)) return
      completedRequestsRef.current.add(requestId)
      if (completedRequestsRef.current.size > 200)
        completedRequestsRef.current.delete(completedRequestsRef.current.values().next().value!)
      if (paintRaf.current) {
        cancelAnimationFrame(paintRaf.current)
        paintRaf.current = 0
      }
      const thinkingRaw = thinkingAcc.current
      let content = promoteThinkingToAnswer(answerAcc.current, thinkingRaw)
      if (!content.trim() && thinkingRaw && !aborted) {
        content = promoteThinkingToAnswer('', thinkingRaw)
      }
      if (!content.trim() && !aborted && !imageAssetsRef.current.length) {
        content = 'The agent ended without a response. Please retry the message or report this run.'
      }
      const thinking = stripAnswerFromThinking(thinkingRaw, content)
      if (aborted) {
        if (content) {
          content = content.endsWith('\n') ? `${content}_(stopped)_` : `${content}\n\n_(stopped)_`
        } else if (thinking) {
          content = '_(stopped)_'
        }
      }
      const threadId = requestThreadIdRef.current
      const meta = routeMetaRef.current
      setAgentStatus(null)
      setPendingApprovals((current) => current.filter((approval) => approval.kind === 'mcp'))
      setPendingQuestion(null)
      requestIdRef.current = null
      if (aborted) userStoppedRef.current = true
      thinkingAcc.current = ''
      answerAcc.current = ''
      const savedDelegations = delegationsRef.current
      delegationsRef.current = []
      setDelegations([])
      const message: ChatMessage = {
        id: `${requestId}:assistant`,
        role: 'assistant',
        content,
        thinking: thinking || undefined,
        createdAt: Date.now(),
        agentId: meta.agentId,
        agentName: meta.agentName,
        model: meta.model,
        assets: imageAssetsRef.current.length ? [...imageAssetsRef.current] : undefined,
        delegations: savedDelegations.length ? savedDelegations : undefined
      }
      try {
        if ((!content && !message.assets?.length) || !threadId) return
        const saved = await window.ide.appendChatMessage(
          threadId,
          message,
          meta.model,
          requestWorkspacePathRef.current
        )
        if (activeThreadRef.current?.id === saved.id) {
          const merged = mergeChatTail(activeThreadRef.current, saved)
          activeThreadRef.current = merged
          setActiveThread(merged)
        }
        setThreads((previous) => [saved, ...previous.filter((thread) => thread.id !== saved.id)])
      } catch (error) {
        setChatError(`Reply could not be saved: ${String(error)}`)
        setActiveThread((current) =>
          current?.id === threadId
            ? { ...current, messages: [...current.messages, message] }
            : current
        )
      } finally {
        setThinkingBuffer('')
        setAnswerBuffer('')
        setStreaming(false)
      }
    })
    const offError = window.ide.onChatError(({ requestId, error }) => {
      if (requestId !== requestIdRef.current && requestId !== lastRequestIdRef.current) return
      setStreaming(false)
      setThinkingBuffer('')
      setAnswerBuffer('')
      setAgentStatus(null)
      setPendingQuestion(null)
      setChatError(error)
      requestIdRef.current = null
      // A later model failure must not lose an image already generated for this turn.
      const assets = [...imageAssetsRef.current]
      const threadId = requestThreadIdRef.current
      if (assets.length && threadId) {
        const meta = routeMetaRef.current
        void window.ide
          .appendChatMessage(
            threadId,
            {
              id: `${requestId}:assistant`,
              role: 'assistant',
              content: 'Image assets were generated before the agent stopped with an error.',
              assets,
              createdAt: Date.now(),
              agentId: meta.agentId,
              agentName: meta.agentName,
              model: meta.model
            },
            meta.model,
            requestWorkspacePathRef.current
          )
          .then((saved) => {
            if (activeThreadRef.current?.id === saved.id) {
              const merged = mergeChatTail(activeThreadRef.current, saved)
              activeThreadRef.current = merged
              setActiveThread(merged)
            }
            setThreads((previous) => [
              saved,
              ...previous.filter((thread) => thread.id !== saved.id)
            ])
          })
          .catch((saveError) =>
            setChatError(`Image reply could not be saved: ${String(saveError)}`)
          )
      }
    })
    return () => {
      if (workspaceRefreshTimer) clearTimeout(workspaceRefreshTimer)
      offAsset()
      offImageProgress()
      offThinking()
      offAnswer()
      offRouted()
      offDelegation()
      offTool()
      offDiff()
      offCheckpoint()
      offSessionStep()
      offTerminal()
      offWorkspaceChanged()
      offStatus()
      offApproval()
      offApprovalResolved()
      offQuestion()
      offQuestionResolved()
      offMemoryUpdated()
      offMemoryProposal()
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
    setThreads,
    setTabs,
    setActiveFile,
    setRightPanel,
    setRightCollapsed,
    appendTerminal
  ])

  return {
    streaming,
    setThinkingBuffer,
    setAnswerBuffer,
    chatError,
    setChatError,
    attachments,
    setAttachments,
    addAttachments,
    importFiles,
    routeLabel,
    delegations,
    setAgentStatus,
    pendingApproval,
    pendingQuestion,
    setPendingQuestion,
    memoryNotice,
    setMemoryNotice,
    liveSessionSteps,
    chatMode,
    setChatMode,
    messageQueue,
    setMessageQueue,
    pendingDiffs,
    setPendingDiffs,
    activeCheckpointId,
    sendMessage,
    rerouteLast,
    stopChat,
    newChat
  }
}
