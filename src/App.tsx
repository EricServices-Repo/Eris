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
import { Sidebar } from '@/layout/Sidebar'
import { WorkspaceTrustBanner } from '@/features/workspace/WorkspaceTrustBanner'
import { StatusBar } from '@/layout/StatusBar'
import {
  ConnectionStatusStrip,
  buildConnectionIssues
} from '@/layout/ConnectionStatusStrip'
import { UpdateBanner } from '@/layout/UpdateBanner'
import { useColumnWidths } from '@/layout/useColumnResize'
import type { UpdateStatusSnapshot, UsageEntitlement } from '@/shared/api'

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
const AgentsPanel = lazy(() =>
  import('@/features/agents/AgentsPanel').then((m) => ({ default: m.AgentsPanel }))
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
    let cancelled = false
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
    const tickAccountUsage = async () => {
      try {
        const [acct, usage] = await Promise.all([
          window.ide.ericServicesStatus(),
          window.ide.getUsageStats(1)
        ])
        if (cancelled) return
        setAccountNeedsReauth(Boolean(acct.needsReauth))
        setAccountStatusError(acct.error || null)
        setEntitlement(usage.entitlement ?? null)
      } catch {
        // non-fatal
      }
    }
    // Defer probes so they never race boot IPC / first paint.
    const startId = window.setTimeout(() => {
      void tickCloud()
      void tickAccountUsage()
    }, 2_500)
    const cloudId = window.setInterval(() => void tickCloud(), 15_000)
    const usageId = window.setInterval(() => void tickAccountUsage(), 30_000)
    return () => {
      cancelled = true
      window.clearTimeout(startId)
      window.clearInterval(cloudId)
      window.clearInterval(usageId)
    }
  }, [settings?.ericServices?.linked, settings?.ericServices?.plan])

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
  const { threads, setThreads, activeThread, setActiveThread, activeThreadRef, refreshChats } =
    useChatThreads()

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
  const { breakpoints, setBreakpoints } = useBreakpoints(workspacePath)

  const {
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
    runInBackground,
    stopChat,
    newChat
  } = useChatSession({
    settings,
    settingsRef,
    selectedModel,
    selectedAgentId,
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
  })

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

        void window.ide.getUpdateStatus().then(setUpdateStatus).catch(() => {})

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
        id: 'agents',
        label: 'Toggle Background Agents',
        run: () => {
          setRightCollapsed(false)
          setRightPanel((p) => (p === 'agents' ? 'editor' : 'agents'))
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
          onOpenAgent: () => openSettings('agent'),
          onWorkLocal: () => showRightPanel('agents')
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
            onAttachFile={(path) => addAttachments([{ path, name: path.split('/').pop() || path }])}
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
                    prev && list.some((t) => t.id === prev.id) ? prev : (list[0] ?? null)
                  )
                }
              })
            }}
            onOpenAgentsPanel={() => showRightPanel('agents')}
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
                  onRunInBackground={(goal) => void runInBackground(goal)}
                  pendingApproval={pendingApproval}
                  onApprovalDecision={(approvalId, decision) => {
                    setPendingApproval(null)
                    void window.ide.respondCommandApproval(approvalId, decision)
                  }}
                  onRerouteLast={(route) => void rerouteLast(route)}
                  resumableRun={resumableRun}
                  onResumeRun={() => void resumeLastRun()}
                  onDismissResume={() => {
                    if (resumableRun) void window.ide.dismissRun(resumableRun.id)
                    setResumableRun(null)
                  }}
                  queuedMessages={messageQueue}
                  onQueueMessage={(text, files, skillIds) => {
                    setMessageQueue((prev) => {
                      if (prev.length >= MAX_QUEUED_MESSAGES) return prev
                      return [...prev, { id: uid(), text, attachments: files, skillIds }]
                    })
                  }}
                  onRemoveQueued={(id) => setMessageQueue((prev) => prev.filter((q) => q.id !== id))}
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
                  className={`icon-rail-btn${rightPanel === 'agents' ? ' active' : ''}`}
                  title="Agents"
                  aria-label="Agents"
                  disabled={!workspacePath}
                  onClick={() => showRightPanel('agents')}
                >
                  ↻
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
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'agents'}
                      className={`right-panel-tab ${rightPanel === 'agents' ? 'active' : ''}`}
                      onClick={() => setRightPanel('agents')}
                    >
                      Agents
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'evals'}
                      className={`right-panel-tab ${rightPanel === 'evals' ? 'active' : ''}`}
                      onClick={() => setRightPanel('evals')}
                    >
                      Evals
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={rightPanel === 'codemap'}
                      className={`right-panel-tab ${rightPanel === 'codemap' ? 'active' : ''}`}
                      onClick={() => setRightPanel('codemap')}
                    >
                      Codemap
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
              ) : rightPanel === 'agents' ? (
                <Suspense fallback={<div className="editor-empty">Loading agents…</div>}>
                  <AgentsPanel
                    open
                    workspacePath={workspacePath}
                    defaultModel={selectedModel || settings?.models.defaultModel || ''}
                    selectedAgentId={selectedAgentId}
                    activeThreadId={activeThread?.id ?? null}
                    onClose={() => showRightPanel('editor')}
                    onBroughtToChat={(threadId) => {
                      void refreshChats(threadId)
                      showRightPanel('editor')
                    }}
                    onCloudDiffs={(diffs) => {
                      setPendingDiffs((prev) => [...prev.filter((d) => d.status === 'pending'), ...diffs])
                      showRightPanel('editor')
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
                </Suspense>
              )}
            </div>
          </div>
        </div>

        {workspacePath && pendingDiffs.length > 0 && (
          <div
            className={`bottom-drawer${diffReviewExpanded ? ' is-diff-expanded' : ''}`}
          >
            <Suspense fallback={null}>
            <DiffReview
              diffs={pendingDiffs}
              theme={settings?.editor.theme}
              expanded={diffReviewExpanded}
              onExpandedChange={setDiffReviewExpanded}
              onOpenPath={(path) => {
                const abs = path.startsWith('/') ? path : `${workspacePath}/${path.split(' → ')[0]}`
                void openFile(abs)
              }}
              onKeep={(id) =>
                setPendingDiffs((prev) =>
                  prev.map((d) => (d.id === id ? { ...d, status: 'kept' } : d))
                )
              }
              onKeepAll={() =>
                setPendingDiffs((prev) =>
                  prev.map((d) => (d.status === 'pending' ? { ...d, status: 'kept' as const } : d))
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
              onStageKept={() => {
                void (async () => {
                  const paths = pendingDiffs
                    .filter((d) => d.status === 'kept')
                    .map((d) => d.path.split(' → ')[0] || d.path)
                  if (!paths.length) return
                  const res = await window.ide.gitStage(paths)
                  if (!res.ok) setChatError(res.error || 'Stage failed')
                  else setAgentStatus(`Staged ${paths.length} file(s)`)
                })()
              }}
              onCommitKept={() => {
                void (async () => {
                  const paths = pendingDiffs
                    .filter((d) => d.status === 'kept')
                    .map((d) => d.path.split(' → ')[0] || d.path)
                  if (!paths.length) return
                  const message =
                    window.prompt('Commit message', `Agent: update ${paths.length} file(s)`) || ''
                  if (!message.trim()) return
                  const staged = await window.ide.gitStage(paths)
                  if (!staged.ok) {
                    setChatError(staged.error || 'Stage failed')
                    return
                  }
                  const committed = await window.ide.gitCommit(message.trim())
                  if (!committed.ok) setChatError(committed.error || 'Commit failed')
                  else setAgentStatus('Committed kept changes')
                })()
              }}
              onCreatePr={() => {
                void (async () => {
                  const paths = pendingDiffs
                    .filter((d) => d.status === 'kept')
                    .map((d) => d.path.split(' → ')[0] || d.path)
                  if (!paths.length) return
                  const title =
                    window.prompt('Pull request title', `Agent updates (${paths.length} files)`) ||
                    ''
                  if (!title.trim()) return
                  const staged = await window.ide.gitStage(paths)
                  if (!staged.ok) {
                    setChatError(staged.error || 'Stage failed')
                    return
                  }
                  const committed = await window.ide.gitCommit(title.trim())
                  if (!committed.ok) {
                    setChatError(committed.error || 'Commit failed')
                    return
                  }
                  const pr = await window.ide.githubCreatePullRequest({ title: title.trim() })
                  if (!pr.ok) setChatError(pr.error || 'Could not create pull request')
                  else {
                    setAgentStatus(
                      typeof pr.number === 'number'
                        ? `Opened PR #${pr.number}${pr.htmlUrl ? ` · ${pr.htmlUrl}` : ''}`
                        : pr.htmlUrl || 'Opened pull request'
                    )
                  }
                })()
              }}
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
                          x.path === t.path ? { ...x, content: file.content, dirty: false } : x
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
                  setPendingDiffs((prev) => prev.map((d) => ({ ...d, status: 'undone' as const })))
                  setTree(await window.ide.listTree(workspacePath))
                  for (const t of tabsRef.current) {
                    try {
                      const file = await window.ide.readFile(t.path)
                      setTabs((prev) =>
                        prev.map((x) =>
                          x.path === t.path ? { ...x, content: file.content, dirty: false } : x
                        )
                      )
                    } catch {
                      // ignore
                    }
                  }
                })()
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
        onAgentChange={setSelectedAgentId}
      />

      {settingsMounted && (
        <Suspense
          fallback={
            settingsOpen ? (
              <div className="modal-backdrop">
                <div className="modal settings-modal-loading">
                  <div className="modal-content">
                    <h2>Settings</h2>
                    <p className="subtitle">Loading…</p>
                  </div>
                </div>
              </div>
            ) : null
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
