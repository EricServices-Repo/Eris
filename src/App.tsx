import { LoadingSettingsDialog } from '@/components/LoadingSettingsDialog'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type { FileEntry } from '@/shared/settings-schema'
import type { CloudHealth } from '@/shared/cloud-agents'
import { joinWorkspacePath, pathBasename } from '@/shared/paths'
import { Sidebar } from '@/layout/Sidebar'
import { WorkspaceTrustBanner } from '@/features/workspace/WorkspaceTrustBanner'
import { StatusBar } from '@/layout/StatusBar'
import { ConnectionStatusStrip, buildConnectionIssues } from '@/layout/ConnectionStatusStrip'
import { UpdateBanner } from '@/layout/UpdateBanner'
import { useColumnWidths } from '@/layout/useColumnResize'
import type { UpdateStatusSnapshot, UsageEntitlement } from '@/shared/api'
import { meterAgainstLimit, previewPlanLabel } from '@/shared/eris-plan'

/** Keep in sync with ChatPanel.MAX_QUEUED_MESSAGES (avoid eager ChatPanel import). */
const MAX_QUEUED_MESSAGES = 3
import { CommandPalette, type CommandItem } from '@/features/palette/CommandPalette'
import { CreateWorkspaceModal } from '@/features/workspace/CreateWorkspaceModal'
import { SetupWizard } from '@/features/onboarding/SetupWizard'
import { useSettingsState } from '@/hooks/useSettingsState'
import { useModels } from '@/hooks/useModels'
import { useSkills } from '@/hooks/useSkills'
import { useLayout } from '@/hooks/useLayout'
import { useChatThreads } from '@/hooks/useChatThreads'
import { useWorkspace } from '@/hooks/useWorkspace'
import { useBreakpoints } from '@/hooks/useBreakpoints'
import { useChatSession } from '@/hooks/useChatSession'
import { uid } from '@/hooks/uid'
import type { TerminalNote } from '@/features/terminal/TerminalPanel'
import logo from '@/assets/logo.png'
import { updateDocument } from '@/state/documents'
import type { PendingDiff } from '@/features/chat/DiffReview'
import { restoreReviewedDocuments } from '@/features/editor/restore-documents'

const MAX_TERMINAL_NOTES = 500

const EditorArea = lazy(() =>
  import('@/features/editor/EditorArea').then((m) => ({ default: m.EditorArea }))
)
const TerminalPanel = lazy(() =>
  import('@/features/terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel }))
)
const SettingsModal = lazy(() =>
  import('@/features/settings/SettingsModal').then((m) => ({ default: m.SettingsModal }))
)
const EvalsPanel = lazy(() =>
  import('@/features/evals/EvalsPanel').then((m) => ({ default: m.EvalsPanel }))
)
const ChatPanel = lazy(() =>
  import('@/features/chat/ChatPanel').then((m) => ({ default: m.ChatPanel }))
)
const DiffReview = lazy(() =>
  import('@/features/chat/DiffReview').then((m) => ({ default: m.DiffReview }))
)
const GitPanel = lazy(() =>
  import('@/features/git/GitPanel').then((m) => ({ default: m.GitPanel }))
)
const SearchPanel = lazy(() =>
  import('@/features/search/SearchPanel').then((m) => ({ default: m.SearchPanel }))
)
const DebugPanel = lazy(() =>
  import('@/features/debug/DebugPanel').then((m) => ({ default: m.DebugPanel }))
)
const CodemapPanel = lazy(() =>
  import('@/features/codemap/CodemapPanel').then((m) => ({ default: m.CodemapPanel }))
)
const AgentsInboxPanel = lazy(() =>
  import('@/features/agents/AgentsInboxPanel').then((m) => ({ default: m.AgentsInboxPanel }))
)
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

export default function App() {
  const {
    settings,
    setSettings,
    settingsRef,
    refreshSettings,
    settingsOpen,
    setSettingsOpen,
    settingsCategory,
    setSettingsCategory,
    startCreateSkill,
    setStartCreateSkill,
    openSettings
  } = useSettingsState()
  const [settingsMounted, setSettingsMounted] = useState(false)
  const [diffReviewExpanded, setDiffReviewExpanded] = useState(true)
  const [diffGitBusy, setDiffGitBusy] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [workspaceModal, setWorkspaceModal] = useState<null | 'create' | 'link'>(null)
  const [showSetupWizard, setShowSetupWizard] = useState(false)
  /** Leaves the splash once boot IPC finishes (success or failure). */
  const [bootReady, setBootReady] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusSnapshot | null>(null)
  const [cloudHealth, setCloudHealth] = useState<CloudHealth | null>(null)
  const [entitlement, setEntitlement] = useState<UsageEntitlement | null>(null)
  const [accountNeedsReauth, setAccountNeedsReauth] = useState(false)
  const [accountStatusError, setAccountStatusError] = useState<string | null>(null)
  const [dismissedIssues, setDismissedIssues] = useState<Record<string, true>>({})
  const [terminalNotes, setTerminalNotes] = useState<TerminalNote[]>([])
  const terminalNoteSeq = useRef(0)
  const appendTerminal = useCallback((text: string) => {
    const id = ++terminalNoteSeq.current
    setTerminalNotes((prev) => [...prev.slice(-(MAX_TERMINAL_NOTES - 1)), { id, text }])
  }, [])

  useEffect(() => {
    const chatFont = settings?.editor.chatFont ?? 'mono'
    const root = document.documentElement
    root.dataset.chatFont = chatFont
    root.style.setProperty(
      '--chat-response-font',
      chatFont === 'sans'
        ? 'var(--font-ui)'
        : chatFont === 'serif'
          ? 'var(--font-serif)'
          : 'var(--font-mono)'
    )
  }, [settings?.editor.chatFont])

  useEffect(() => {
    if (!settings?.ericServices) return
    setEntitlement((prev) => {
      if (prev) return prev
      const preview = previewPlanLabel(settings.ericServices.plan, settings.ericServices.linked)
      const open = meterAgainstLimit(0, null)
      return {
        plan: preview.plan,
        planLabel: preview.planLabel,
        authenticated: Boolean(settings.ericServices.linked),
        limits: preview.limits,
        requests: open,
        tokens: open,
        cloudJobs: meterAgainstLimit(0, preview.limits.cloudJobsPerDay),
        overLimit: false,
        blockedReason: null,
        upgradeUrl: '',
        accountUrl: '',
        profileSynced: false
      }
    })
  }, [settings?.ericServices])

  useEffect(() => {
    if (!bootReady) return
    let cancelled = false
    const applyAccount = async (live: boolean) => {
      try {
        const [acct, usage] = await Promise.all([
          window.ide.ericServicesStatus(live ? undefined : { cached: true }),
          window.ide.getUsageStats(1, { refresh: live })
        ])
        if (cancelled) return
        setAccountNeedsReauth(Boolean(acct.needsReauth))
        setAccountStatusError(acct.error || null)
        if (usage.entitlement) setEntitlement(usage.entitlement)
      } catch {
        // non-fatal
      }
    }
    const tickCloud = async () => {
      try {
        const health = await window.ide.cloudAgentsHealth()
        if (!cancelled) setCloudHealth(health)
      } catch {
        if (!cancelled) {
          setCloudHealth({
            ok: false,
            authenticated: false,
            service: 'eris-cloud-agent',
            version: '',
            llmConfigured: false,
            maxParallel: 0,
            running: 0,
            queued: 0,
            error: 'Unreachable'
          })
        }
      }
    }
    void applyAccount(false).finally(() => {
      void applyAccount(true)
    })
    void tickCloud()
    const cloudId = window.setInterval(() => void tickCloud(), 15_000)
    const usageId = window.setInterval(() => void applyAccount(true), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(cloudId)
      window.clearInterval(usageId)
    }
  }, [bootReady, settings?.ericServices?.linked, settings?.ericServices?.plan])

  // Prefetch Settings chunk after boot so first open isn't a blank wait on the JS chunk.
  useEffect(() => {
    if (!bootReady) return
    const id = window.setTimeout(() => {
      void import('@/features/settings/SettingsModal')
      setSettingsMounted(true)
    }, 600)
    return () => window.clearTimeout(id)
  }, [bootReady])

  const {
    models,
    selectedModel,
    setSelectedModel,
    ollamaOk,
    setOllamaOk,
    composerReady,
    setComposerReady,
    agents,
    selectedAgentId,
    setSelectedAgentId,
    refreshModels
  } = useModels(settings)

  const pinAgent = (agentId: string | 'auto') => {
    setSelectedAgentId(agentId)
    void window.ide
      .setSettings('user', { agent: { routing: { pinnedAgentId: agentId } } })
      .then(setSettings)
  }
  const { skills, refreshSkills, activeSkills, setActiveSkills } = useSkills()
  const {
    rightPanel,
    setRightPanel,
    leftCollapsed,
    setLeftCollapsed,
    rightCollapsed,
    setRightCollapsed,
    searchOpen,
    setSearchOpen,
    showRightPanel
  } = useLayout()
  const {
    leftWidth,
    rightWidth,
    resizing,
    onLeftResizePointerDown,
    onRightResizePointerDown,
    resetLeftWidth,
    resetRightWidth
  } = useColumnWidths()
  const {
    threads,
    setThreads,
    activeThread,
    setActiveThread,
    activeThreadRef,
    refreshChats,
    selectThread,
    loadEarlier,
    loadNewer,
    jumpToLatest,
    openMessage,
    history
  } = useChatThreads()

  const {
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
  } = useWorkspace({
    setSettings,
    refreshSettings,
    refreshModels,
    selectedModel,
    setSelectedModel,
    activeThreadId: activeThread?.id ?? null,
    setThreads,
    setActiveThread,
    refreshChats,
    refreshSkills,
    setActiveSkills,
    showRightPanel
  })
  const windowWorkspaceRef = useRef(workspacePath)
  windowWorkspaceRef.current = workspacePath
  const { breakpoints, setBreakpoints } = useBreakpoints(workspacePath)

  const {
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
    sendMessage,
    rerouteLast,
    stopChat,
    newChat
  } = useChatSession({
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
  })

  const reviewBusy = useRef(false)
  const reviewDiffs = async (targets: PendingDiff[], decision: 'keep' | 'undo') => {
    const root = workspacePath
    const threadId = activeThread?.id
    if (!root || reviewBusy.current) return
    const pending = targets.filter((d) => d.status === 'pending')
    if (!pending.length) return
    reviewBusy.current = true
    const current = () =>
      windowWorkspaceRef.current === root && activeThreadRef.current?.id === threadId
    const apply = async () => {
      for (const checkpointId of [...new Set(pending.map((d) => d.checkpointId))].reverse()) {
        try {
          const receipts = await window.ide.decideCheckpointReview({
            checkpointId,
            opIndices: pending.filter((d) => d.checkpointId === checkpointId).map((d) => d.opIndex),
            decision
          })
          if (!current()) return
          setPendingDiffs((prev) =>
            prev.map((d) => {
              const receipt =
                d.checkpointId === checkpointId
                  ? receipts.find((r) => r.opIndex === d.opIndex)
                  : undefined
              if (!receipt) return d
              return receipt.status === 'conflicted'
                ? { ...d, conflict: receipt.reason }
                : { ...d, status: receipt.status, conflict: undefined }
            })
          )
          const conflicts = receipts.filter((r) => r.status === 'conflicted')
          if (conflicts.length) setChatError(conflicts.map((r) => r.reason).join('\n'))
        } catch (error) {
          if (current()) setChatError(error instanceof Error ? error.message : String(error))
          break
        }
      }
    }
    try {
      if (decision === 'undo') {
        await restoreReviewedDocuments({
          targets: pending.flatMap((d) =>
            d.path.split(' → ').map((path) => joinWorkspacePath(root, path))
          ),
          getTabs: () => tabsRef.current,
          current,
          restore: apply,
          readFile: window.ide.readFile,
          setTabs
        })
        if (current()) setTree(await window.ide.listTree(root))
      } else await apply()
    } catch (error) {
      if (current()) setChatError(error instanceof Error ? error.message : String(error))
    } finally {
      reviewBusy.current = false
    }
  }

  useEffect(() => {
    let cancelled = false
    const BOOT_TIMEOUT_MS = 8_000

    const withTimeout = <T,>(promise: Promise<T>, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error(`${label} timed out after ${BOOT_TIMEOUT_MS}ms`)),
          BOOT_TIMEOUT_MS
        )
        promise.then(
          (value) => {
            window.clearTimeout(timer)
            resolve(value)
          },
          (err) => {
            window.clearTimeout(timer)
            reject(err)
          }
        )
      })

    void (async () => {
      // Hard ceiling: never leave the user on "Loading Eris…" forever.
      const forceReady = window.setTimeout(() => {
        if (!cancelled) setBootReady(true)
      }, BOOT_TIMEOUT_MS + 500)

      try {
        if (!window.ide) {
          throw new Error('Preload API missing (window.ide)')
        }

        const state = await withTimeout(window.ide.getAppState(), 'getAppState').catch(() => ({
          workspaces: [] as Awaited<ReturnType<typeof window.ide.getAppState>>['workspaces'],
          lastWorkspaceId: null as string | null,
          onboardingCompletedAt: Date.now() as number | null
        }))
        const versionInfo = await window.ide.getAppVersion().catch(() => null)
        let resolved: Awaited<ReturnType<typeof refreshSettings>> | null = null
        try {
          resolved = await withTimeout(refreshSettings(), 'getResolvedSettings')
        } catch (err) {
          if (!cancelled) {
            setBootError(err instanceof Error ? err.message : String(err))
          }
        }

        if (cancelled) return
        if (versionInfo?.version) setAppVersion(versionInfo.version)
        setWorkspaces(state.workspaces || [])
        const needsOnboarding = !state.onboardingCompletedAt
        setShowSetupWizard(needsOnboarding)
        setBootReady(true)

        void window.ide
          .getUpdateStatus()
          .then(setUpdateStatus)
          .catch(() => {})

        if (resolved) {
          void refreshModels(resolved)
          void refreshSkills()
          if (!needsOnboarding && resolved.general.restoreLastWorkspace && state.lastWorkspaceId) {
            const last = (state.workspaces || []).find((w) => w.id === state.lastWorkspaceId)
            if (last) void loadWorkspace(last)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setBootError(err instanceof Error ? err.message : String(err))
          setBootReady(true)
        }
      } finally {
        window.clearTimeout(forceReady)
      }
    })()

    return () => {
      cancelled = true
    }
    // One-time boot; the loaders are recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const offs = [
      window.ide.onMenu('menu:settings', () => openSettings()),
      window.ide.onMenu('menu:open-folder', () => setWorkspaceModal('link')),
      window.ide.onMenu('menu:new-workspace', () => setWorkspaceModal('create')),
      window.ide.onMenu('menu:save', () => void saveActive()),
      window.ide.onMenu('menu:command-palette', () => setPaletteOpen(true)),
      window.ide.onMenu('menu:new-chat', () => void newChat()),
      window.ide.onMenu('menu:stop-chat', () => stopChat()),
      window.ide.onMenu('menu:report-bug', () => openSettings('feedback'))
    ]
    return () => offs.forEach((off) => off())
  }, [saveActive, newChat, openSettings, stopChat])

  useEffect(() => {
    const off = window.ide.onUpdateStatus((s) => setUpdateStatus(s))
    return () => off()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        (e.target as Element)?.closest?.('[aria-modal="true"]')
      )
        return
      if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
        const selectors: Record<string, string> = {
          '1': '[data-chat-composer]',
          '2': '.diff-review',
          '3': '.monaco-editor textarea',
          '4': '.agents-inbox'
        }
        const target = selectors[e.key] && document.querySelector<HTMLElement>(selectors[e.key])
        if (target) {
          e.preventDefault()
          target.focus()
          return
        }
      }
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
      ...[
        ['chat', 'Chat composer', '[data-chat-composer]'],
        ['review', 'Review changes', '.diff-review'],
        ['editor', 'Editor', '.monaco-editor textarea'],
        ['inbox', 'Agents inbox', '.agents-inbox']
      ].map(([id, label, selector], i) => ({
        id: `focus-${id}`,
        label: `Focus ${label}`,
        shortcut: `Ctrl+Alt+${i + 1}`,
        run: () => document.querySelector<HTMLElement>(selector)?.focus()
      })),
      {
        id: 'report-bug',
        label: 'Send Feedback…',
        run: () => openSettings('feedback')
      },
      {
        id: 'logging',
        label: 'Open Logging Settings',
        run: () => openSettings('logging')
      },
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
        id: 'evals',
        label: 'Toggle Eval Scoreboard',
        run: () => {
          setRightCollapsed(false)
          setRightPanel((p) => (p === 'evals' ? 'editor' : 'evals'))
        }
      },
      {
        id: 'codemap',
        label: 'Open Codemap',
        run: () => {
          setRightCollapsed(false)
          setRightPanel('codemap')
        }
      },
      {
        id: 'agents-inbox',
        label: 'Open Agents Inbox',
        run: () => {
          setRightCollapsed(false)
          setRightPanel('agents')
        }
      },
      {
        id: 'verify',
        label: 'Run Verify (typecheck/tests)',
        run: () => {
          void (async () => {
            showRightPanel('terminal')
            appendTerminal('$ verify\n')
            const r = await window.ide.runVerify()
            appendTerminal(`${r.detail}\n`)
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
    [
      saveActive,
      newChat,
      refreshModels,
      openSettings,
      showRightPanel,
      setLeftCollapsed,
      setRightCollapsed,
      setRightPanel,
      setSearchOpen,
      setChatMode,
      stopChat,
      appendTerminal
    ]
  )

  if (settingsOpen && !settingsMounted) setSettingsMounted(true)

  if (!bootReady) {
    return <div className="welcome">Loading Eris…</div>
  }

  if (!settings) {
    return (
      <div className="welcome">
        <h1>Couldn't load settings</h1>
        <p>{bootError || 'Settings IPC failed. Try restarting Eris.'}</p>
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    )
  }

  const commitKept = async (message: string, action: 'stage' | 'commit' = 'commit') => {
    const root = workspacePath
    if (!root) throw new Error('No workspace open')
    const changes = pendingDiffs
      .filter((d) => d.status === 'kept')
      .map((d) => ({ checkpointId: d.checkpointId, opIndex: d.opIndex }))
    const status = await window.ide.gitStatus()
    const head = await window.ide.gitHead()
    if (!status.ok || !status.branch || windowWorkspaceRef.current !== root)
      throw new Error('Repository changed')
    return window.ide.gitCommitReviewed({
      root,
      branch: status.branch,
      head,
      message,
      changes,
      action
    })
  }

  return (
    <div className="app-shell">
      <SetupWizard
        open={showSetupWizard}
        hasWorkspace={Boolean(workspacePath)}
        hasReadyModel={models.some((model) => model.ready)}
        onCreateWorkspace={() => setWorkspaceModal('create')}
        onLinkWorkspace={() => setWorkspaceModal('link')}
        onOpenModelsSettings={() => openSettings('models')}
        onFinished={() => {
          setShowSetupWizard(false)
          void refreshSettings().then((resolved) => refreshModels(resolved))
          void refreshWorkspaceList()
        }}
        onStartFirstWin={() => {
          void (async () => {
            setChatError(null)
            await newChat()
            const prompt =
              'Scan this workspace briefly and suggest one small, safe improvement. If you edit a file, keep the change minimal so I can review it in Diff Review.'
            // Prefill via send after a tick so the new thread is active
            window.setTimeout(() => {
              void sendMessage(prompt, [], [])
            }, 200)
          })()
        }}
      />
      <div className="titlebar">
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
      <ConnectionStatusStrip
        issues={buildConnectionIssues({
          accountNeedsReauth,
          accountError: accountStatusError,
          entitlement,
          cloudHealth,
          modelsOk: ollamaOk,
          composerReady,
          onOpenAccount: () => openSettings('account'),
          onOpenUsage: () => openSettings('usage'),
          onOpenUpgrade: () => void window.ide.ericServicesOpenUpgrade(),
          onOpenModels: () => openSettings('models'),
          onOpenAgent: () => openSettings('agent')
        }).filter((i) => !dismissedIssues[i.id])}
        onDismiss={(id) => setDismissedIssues((prev) => ({ ...prev, [id]: true }))}
      />
      <UpdateBanner
        status={updateStatus}
        onCheck={() => void window.ide.checkForAppUpdates(true)}
        onDownload={() => void window.ide.downloadAppUpdate()}
        onInstall={() => void window.ide.installAppUpdate()}
        onOpenReleases={() => void window.ide.openAppReleasesPage()}
        onDismiss={() => void window.ide.dismissAppUpdate()}
      />
      <WorkspaceTrustBanner
        workspacePath={workspacePath}
        onTrustChanged={() => {
          void refreshSettings().then((resolved) => refreshModels(resolved))
        }}
      />
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
            onAttachFile={(path) => addAttachments([{ path, name: pathBasename(path) }])}
            onSelectThread={(id) => {
              void selectThread(id).catch((error) => setChatError(String(error)))
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
                  await selectThread(list[0]?.id ?? null)
                  setChatError(null)
                  setThinkingBuffer('')
                  setAnswerBuffer('')
                } else {
                  if (!activeThread || !list.some((thread) => thread.id === activeThread.id))
                    await selectThread(list[0]?.id ?? null)
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
              <Suspense fallback={<div className="welcome">Loading chat…</div>}>
                <ChatPanel
                  workspacePath={workspacePath}
                  activeThread={activeThread}
                  onLoadEarlier={loadEarlier}
                  onLoadNewer={loadNewer}
                  onJumpToLatest={jumpToLatest}
                  onOpenMessage={openMessage}
                  history={history}
                  routeLabel={routeLabel}
                  composerReady={composerReady}
                  modelsOk={ollamaOk}
                  streaming={streaming}
                  chatError={chatError}
                  delegations={delegations}
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
                  pendingApproval={pendingApproval}
                  onApprovalDecision={(approvalId, decision) => {
                    void window.ide.respondCommandApproval(approvalId, decision)
                  }}
                  pendingQuestion={pendingQuestion}
                  onQuestionReply={(questionId, reply) => {
                    setPendingQuestion(null)
                    void window.ide.respondUserQuestion(questionId, reply)
                  }}
                  memoryNotice={memoryNotice}
                  onMemoryRemember={() => {
                    if (!memoryNotice || memoryNotice.kind !== 'proposal') return
                    const { note, summary } = memoryNotice
                    setMemoryNotice(null)
                    void window.ide.confirmProjectMemory({ note, summary }).then((r) => {
                      if (r.wrote) {
                        setMemoryNotice({ kind: 'updated', preview: r.preview })
                      }
                    })
                  }}
                  onMemoryDismiss={() => setMemoryNotice(null)}
                  onMemoryUndo={() => {
                    setMemoryNotice(null)
                    void window.ide.undoProjectMemory()
                  }}
                  onRerouteLast={(route) => void rerouteLast(route)}
                  liveSessionSteps={liveSessionSteps}
                  queuedMessages={messageQueue}
                  onQueueMessage={(text, files, skillIds) => {
                    setMessageQueue((prev) => {
                      if (prev.length >= MAX_QUEUED_MESSAGES) return prev
                      return [...prev, { id: uid(), text, attachments: files, skillIds }]
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
                    void openFile(
                      workspacePath ? joinWorkspacePath(workspacePath, path) : path.split(' → ')[0]!
                    )
                  }}
                  onOpenModelsSettings={() => openSettings('models')}
                  onOpenSkillsSettings={() => {
                    void refreshSkills()
                    openSettings('skills')
                  }}
                  onCreateSkill={() => openSettings('skills', true)}
                  onDismissError={() => setChatError(null)}
                />
              </Suspense>
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
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'evals' ? ' active' : ''}`}
                  title="Evals"
                  aria-label="Evals"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('evals')}
                >
                  ▣
                </button>
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'codemap' ? ' active' : ''}`}
                  title="Codemap"
                  aria-label="Codemap"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('codemap')}
                >
                  ⌖
                </button>
                <button
                  type="button"
                  className={`icon-rail-btn${rightPanel === 'agents' ? ' active' : ''}`}
                  title="Agents Inbox"
                  aria-label="Agents Inbox"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('agents')}
                >
                  ✦
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
              <div className="right-panel-tabs right-panel-header">
                <select
                  className="right-panel-select"
                  aria-label="Select right panel"
                  value={workspacePath ? rightPanel : 'editor'}
                  onChange={(event) => showRightPanel(event.target.value as typeof rightPanel)}
                >
                  <option value="editor">Editor</option>
                  {workspacePath && (
                    <>
                      <option value="terminal">Terminal</option>
                      <option value="git">Git</option>
                      <option value="debug">Debug</option>
                      <option value="evals">Evals</option>
                      <option value="codemap">Codemap</option>
                      <option value="agents">Agents</option>
                    </>
                  )}
                </select>
                <button
                  type="button"
                  className="right-panel-collapse"
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
                <Suspense fallback={<div className="editor-empty">Loading search…</div>}>
                  <SearchPanel
                    open
                    workspacePath={workspacePath}
                    onClose={() => setSearchOpen(false)}
                    onOpenPath={(path, line) => {
                      void openFile(resolveWorkspacePath(path), line)
                      setSearchOpen(false)
                    }}
                  />
                </Suspense>
              )}
              {!workspacePath ? (
                <div className="editor-empty">Open a workspace to edit files.</div>
              ) : rightPanel === 'terminal' ? (
                <Suspense fallback={<div className="editor-empty">Loading terminal…</div>}>
                  <TerminalPanel
                    open
                    workspacePath={workspacePath}
                    notes={terminalNotes}
                    onClose={() => showRightPanel('editor')}
                  />
                </Suspense>
              ) : rightPanel === 'git' ? (
                <Suspense fallback={<div className="editor-empty">Loading git…</div>}>
                  <GitPanel
                    open
                    workspacePath={workspacePath}
                    onClose={() => showRightPanel('editor')}
                    onOpenGithubSettings={() => openSettings('github')}
                    onOpenPath={(path) => {
                      void openFile(resolveWorkspacePath(path))
                    }}
                  />
                </Suspense>
              ) : rightPanel === 'debug' ? (
                <Suspense fallback={<div className="editor-empty">Loading debug…</div>}>
                  <DebugPanel
                    open
                    workspacePath={workspacePath}
                    activeFile={activeFile}
                    onClose={() => showRightPanel('editor')}
                    onOpenPath={(path, line) => {
                      void openFile(resolveWorkspacePath(path), line)
                    }}
                  />
                </Suspense>
              ) : rightPanel === 'evals' ? (
                <Suspense fallback={<div className="editor-empty">Loading evals…</div>}>
                  <EvalsPanel
                    open
                    models={models.map((m) => m.name)}
                    defaultModel={selectedModel || settings?.models.defaultModel || ''}
                    onClose={() => showRightPanel('editor')}
                  />
                </Suspense>
              ) : rightPanel === 'codemap' ? (
                <Suspense fallback={<div className="editor-empty">Loading codemap…</div>}>
                  <CodemapPanel
                    workspacePath={workspacePath}
                    onOpenPath={(path, line) => {
                      void openFile(path, line)
                      showRightPanel('editor')
                    }}
                    onOpenSettings={(cat) => openSettings(cat)}
                  />
                </Suspense>
              ) : rightPanel === 'agents' ? (
                <Suspense fallback={<div className="editor-empty">Loading agents…</div>}>
                  <AgentsInboxPanel
                    onOpenPath={(path) => {
                      void openFile(resolveWorkspacePath(path))
                      showRightPanel('editor')
                    }}
                    onOpenChat={() => {
                      /* chat is always visible on the left */
                    }}
                  />
                </Suspense>
              ) : (
                <Suspense fallback={<div className="editor-empty">Loading editor…</div>}>
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
                    onAcceptPatch={(id) => {
                      void reviewDiffs(
                        pendingDiffs.filter((d) => d.id === id),
                        'keep'
                      )
                    }}
                    onRejectPatch={(id) => {
                      void reviewDiffs(
                        pendingDiffs.filter((d) => d.id === id),
                        'undo'
                      )
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
                    onSelect={(path) => void openFile(path)}
                    onClose={(path) => {
                      setTabs((prev) => {
                        const next = prev.filter((t) => t.path !== path)
                        if (activeFile === path) setActiveFile(next[next.length - 1]?.path ?? null)
                        return next
                      })
                    }}
                    onChange={(path, content) => {
                      const tab = tabsRef.current.find((tab) => tab.path === path)
                      if (!tab) return
                      updateDocument(path, content)
                      if (!tab.dirty) {
                        setTabs((prev) =>
                          prev.map((tab) => (tab.path === path ? { ...tab, dirty: true } : tab))
                        )
                      }
                    }}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </div>

        {workspacePath && pendingDiffs.length > 0 && (
          <div className={`bottom-drawer${diffReviewExpanded ? ' is-diff-expanded' : ''}`}>
            <Suspense fallback={null}>
              <DiffReview
                diffs={pendingDiffs}
                theme={settings?.editor.theme}
                expanded={diffReviewExpanded}
                onExpandedChange={setDiffReviewExpanded}
                onOpenPath={(path) => {
                  const abs = workspacePath
                    ? joinWorkspacePath(workspacePath, path)
                    : path.split(' → ')[0]!
                  void openFile(abs)
                }}
                onKeep={(id) => {
                  void reviewDiffs(
                    pendingDiffs.filter((d) => d.id === id),
                    'keep'
                  )
                }}
                onKeepAll={() => {
                  void reviewDiffs(pendingDiffs, 'keep')
                }}
                autoKeepDiffs={Boolean(settings?.agent.autoKeepDiffs)}
                onAutoKeepDiffsChange={(enabled) => {
                  void window.ide
                    .setSettings('user', { agent: { autoKeepDiffs: enabled } })
                    .then(setSettings)
                  if (enabled) void reviewDiffs(pendingDiffs, 'keep')
                }}
                onDismiss={() => setPendingDiffs([])}
                gitBusy={diffGitBusy}
                onStageKept={() => {
                  void (async () => {
                    const paths = pendingDiffs
                      .filter((d) => d.status === 'kept')
                      .flatMap((d) => d.path.split(' → '))
                    if (!paths.length) return
                    setDiffGitBusy(true)
                    try {
                      const res = await commitKept('Stage reviewed changes', 'stage')
                      if (!res.ok) setChatError(res.error || 'Stage failed')
                      else setAgentStatus(`Staged ${paths.length} file(s)`)
                    } catch (error) {
                      setChatError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setDiffGitBusy(false)
                    }
                  })()
                }}
                onCommitKept={() => {
                  void (async () => {
                    const paths = pendingDiffs
                      .filter((d) => d.status === 'kept')
                      .flatMap((d) => d.path.split(' → '))
                    if (!paths.length) return
                    const message =
                      window.prompt('Commit message', `Agent: update ${paths.length} file(s)`) || ''
                    if (!message.trim()) return
                    setDiffGitBusy(true)
                    try {
                      const committed = await commitKept(message.trim())
                      if (!committed.ok) setChatError(committed.error || 'Commit failed')
                      else setAgentStatus('Committed kept changes')
                    } catch (error) {
                      setChatError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setDiffGitBusy(false)
                    }
                  })()
                }}
                onCommitAndPush={() => {
                  void (async () => {
                    const paths = pendingDiffs
                      .filter((d) => d.status === 'kept')
                      .flatMap((d) => d.path.split(' → '))
                    if (!paths.length) return
                    const defaultMsg = `Agent: update ${paths.length} file(s)`
                    const message = window.prompt('Commit message', defaultMsg) || ''
                    if (!message.trim()) return
                    setDiffGitBusy(true)
                    try {
                      const committed = await commitKept(message.trim())
                      if (!committed.ok) {
                        setChatError(committed.error || 'Commit failed')
                        return
                      }
                      if (
                        windowWorkspaceRef.current !== committed.root ||
                        (await window.ide.gitStatus()).branch !== committed.branch
                      )
                        throw new Error('Repository changed before push')
                      const pushed = await window.ide.githubSync('push')
                      if (!pushed.ok) {
                        setChatError(pushed.error || 'Push failed')
                        setAgentStatus('Committed locally — push failed')
                        return
                      }
                      setAgentStatus('Committed & pushed kept changes')
                    } catch (error) {
                      setChatError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setDiffGitBusy(false)
                    }
                  })()
                }}
                onCreatePr={() => {
                  void (async () => {
                    const paths = pendingDiffs
                      .filter((d) => d.status === 'kept')
                      .flatMap((d) => d.path.split(' → '))
                    if (!paths.length) return
                    const title =
                      window.prompt(
                        'Pull request title',
                        `Agent updates (${paths.length} files)`
                      ) || ''
                    if (!title.trim()) return
                    setDiffGitBusy(true)
                    try {
                      const committed = await commitKept(title.trim())
                      if (!committed.ok) {
                        setChatError(committed.error || 'Commit failed')
                        return
                      }
                      if (
                        windowWorkspaceRef.current !== committed.root ||
                        (await window.ide.gitStatus()).branch !== committed.branch
                      )
                        throw new Error('Repository changed before PR')
                      const pr = await window.ide.githubCreatePullRequest({ title: title.trim() })
                      if (!pr.ok) setChatError(pr.error || 'Could not create pull request')
                      else {
                        setAgentStatus(
                          typeof pr.number === 'number'
                            ? `Opened PR #${pr.number}${pr.htmlUrl ? ` · ${pr.htmlUrl}` : ''}`
                            : pr.htmlUrl || 'Opened pull request'
                        )
                      }
                    } catch (error) {
                      setChatError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setDiffGitBusy(false)
                    }
                  })()
                }}
                onUndoFile={(id) => {
                  void reviewDiffs(
                    pendingDiffs.filter((d) => d.id === id),
                    'undo'
                  )
                }}
                onUndoAll={() => {
                  void reviewDiffs(pendingDiffs, 'undo')
                }}
              />
            </Suspense>
          </div>
        )}
      </div>

      <StatusBar
        agents={agents}
        selectedAgentId={selectedAgentId}
        routeLabel={routeLabel}
        composerReady={composerReady}
        modelsOk={ollamaOk}
        cloudHealth={cloudHealth}
        entitlement={entitlement}
        accountNeedsReauth={accountNeedsReauth}
        appVersion={appVersion}
        updateStatus={updateStatus}
        disabled={!workspacePath}
        onOpenSettings={() => openSettings()}
        onOpenAgentSettings={() => openSettings('agent')}
        onOpenModels={() => openSettings('models')}
        onOpenUsage={() => openSettings('usage')}
        onOpenAccount={() => openSettings('account')}
        onCheckUpdates={() => void window.ide.checkForAppUpdates(false)}
        onAgentChange={pinAgent}
      />

      {settingsMounted && (
        <Suspense
          fallback={
            settingsOpen ? <LoadingSettingsDialog onClose={() => setSettingsOpen(false)} /> : null
          }
        >
          <SettingsModal
            open={settingsOpen}
            hasWorkspace={Boolean(workspacePath)}
            seedResolved={settings}
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
        </Suspense>
      )}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
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
