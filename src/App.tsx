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
import { useColumnWidths } from '@/layout/useColumnResize'
import { ChatPanel, MAX_QUEUED_MESSAGES } from '@/features/chat/ChatPanel'
import { DiffReview } from '@/features/chat/DiffReview'
import { GitPanel } from '@/features/git/GitPanel'
import { SearchPanel } from '@/features/search/SearchPanel'
import { DebugPanel } from '@/features/debug/DebugPanel'
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [workspaceModal, setWorkspaceModal] = useState<null | 'create' | 'link'>(null)
  const [showSetupWizard, setShowSetupWizard] = useState(false)
  const [onboardingReady, setOnboardingReady] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [cloudHealth, setCloudHealth] = useState<CloudHealth | null>(null)
  const [terminalNotes, setTerminalNotes] = useState<TerminalNote[]>([])
  const terminalNoteSeq = useRef(0)
  const appendTerminal = useCallback((text: string) => {
    const id = ++terminalNoteSeq.current
    setTerminalNotes((prev) => [...prev.slice(-(MAX_TERMINAL_NOTES - 1)), { id, text }])
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const health = await window.ide.cloudAgentsHealth()
        if (!cancelled) setCloudHealth(health)
      } catch {
        if (!cancelled) {
          setCloudHealth({
            ok: false,
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
    void tick()
    const id = window.setInterval(() => void tick(), 15_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

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
      window.ide.onMenu('menu:stop-chat', () => stopChat())
    ]
    return () => offs.forEach((off) => off())
  }, [saveActive, newChat, openSettings, stopChat])

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
                <Suspense fallback={<div className="editor-empty">Loading terminal…</div>}>
                  <TerminalPanel
                    open
                    workspacePath={workspacePath}
                    notes={terminalNotes}
                    onClose={() => showRightPanel('editor')}
                  />
                </Suspense>
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
          <div className="bottom-drawer">
            <DiffReview
              diffs={pendingDiffs}
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
        appVersion={appVersion}
        disabled={!workspacePath}
        onOpenSettings={() => openSettings()}
        onOpenAgentSettings={() => openSettings('agent')}
        onAgentChange={setSelectedAgentId}
      />

      {settingsMounted && (
        <Suspense fallback={null}>
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
