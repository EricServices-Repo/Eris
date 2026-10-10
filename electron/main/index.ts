import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  safeStorage,
  dialog
} from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import {
  getLayeredSettings,
  getResolvedSettings,
  setSettings,
  resetSettingKey,
  stripLegacySubagentsFromUserSettings
} from './services/settings'
import {
  getAppState,
  openWorkspaceDialog,
  rememberWorkspace,
  getWorkspaceMeta,
  setWorkspaceMeta,
  listWorkspaces,
  createWorkspaceDialog,
  linkWorkspaceDialog,
  getWorkspaceById,
  renameWorkspace,
  removeWorkspace,
  completeOnboarding,
  resetOnboarding
} from './services/workspace'
import { listTree, readTextFile, writeTextFile, languageFromPath } from './services/files'
import { routeMessage } from './services/router'
import {
  connectionsWithDiscoveredModels,
  getModelsStatus
} from './services/model-catalog'
import { runAgentWithWorkspaceTools } from './services/agent-runner'
import { restoreCheckpoint, restoreCheckpointOp } from './services/checkpoints'
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiff,
  gitStage,
  gitStash,
  gitStatus
} from './services/git-service'
import {
  buildLinkState,
  cloneUrlHttps,
  cloneUrlSsh,
  createGithubPullRequest,
  createGithubRepository,
  detectGithubFromRemote,
  listGithubPullRequests,
  parseGithubRepo,
  pushPullFetch,
  repoPageUrl,
  setRemoteUrl,
  testGithubToken
} from './services/github'
import {
  applyProfileBundle,
  buildEricServicesStatus,
  buildProfileBundle,
  buildSyncableSettings,
  ericServicesFetchMe,
  ericServicesLogin,
  ericServicesLogout,
  ericServicesPullSettings,
  ericServicesPushSettings,
  ericServicesTokenRef
} from './services/ericservices'
import {
  setWorkspaceFsChangeHandler,
  startWorkspaceWatcher,
  stopWorkspaceWatcher
} from './services/workspace-watcher'
import {
  disposeMcpRuntime,
  getMcpStatuses,
  listMcpTools,
  syncMcpRuntime
} from './services/mcp-runtime'
import {
  buildCodeIndexAsync,
  ensureCodeIndex,
  findSymbols,
  notifyWorkspaceFilesChanged
} from './services/code-index'
import {
  retrieveContextAsync,
  workspaceGlob,
  workspaceGrep
} from './services/workspace-search'
import { resolveLoginShellPath } from './services/workspace-env'
import { completeAtCursor, inlineEdit } from './services/inline-ai'
import {
  collectDiagnostics,
  invalidateDiagnosticsCache,
  setDiagnosticsPaused,
  goToDefinition,
  languageHover
} from './services/diagnostics'
import {
  debugContinue,
  debugStepInto,
  debugStepOut,
  debugStepOver,
  getDebugState,
  listBreakpoints,
  listLaunchConfigs,
  onDebugState,
  saveBreakpoints,
  saveLaunchConfigs,
  startDebug,
  stopDebug,
  type LaunchConfig
} from './services/debug-service'
import { runVerify } from './services/verify'
import { deleteRule, listRules, saveRule } from './services/rules'
import {
  appendContextNote,
  formatWorkspaceContextPrompt,
  getWorkspaceContext,
  saveWorkspaceContext,
  setContextSummary
} from './services/workspace-context'
import {
  discoverEmailSources,
  pullEmailContext,
  readPulledEmailContext
} from './services/email-context'
import { clearUsageStats, getUsageSnapshot } from './services/usage-stats'
import { runWorkspaceCommand } from './services/shell-run'
import {
  disposePtySession,
  ensurePtySession,
  onPtyData,
  onPtyExit,
  resizePty,
  writePty
} from './services/pty-session'
import {
  disposeTsLsp,
  lspCompletion,
  lspDefinition,
  lspDidChange,
  lspDidClose,
  lspDidOpen,
  lspHover,
  onLspDiagnostics
} from './services/ts-lsp'
import {
  cancelBuiltinDownload,
  deleteBuiltinModel,
  disposeRuntime,
  downloadBuiltinModel,
  getBuiltinStatuses,
  verifyBuiltinModel
} from './services/builtin-model'
import {
  findAgent,
  getProjectAgents,
  listResolvedAgents,
  saveProjectAgents,
  seedProjectAgents
} from './services/agents'
import {
  listChats,
  getChat,
  createChat,
  saveChat,
  deleteChat,
  loadWorkspaceRules
} from './services/chats'
import {
  createSkill,
  deleteSkill,
  ensureSkillsDirs,
  getSkill,
  listSkills,
  loadSkillsPrompt,
  updateSkill
} from './services/skills'
import { userDataRoot } from './services/paths'
import {
  clearLogs,
  configureLogger,
  getLogsInfo,
  log,
  logError,
  logInfo,
  logWarn,
  openLogsDirectory,
  readLogFile,
  type LogLevel
} from './services/logger'
import type {
  ChatThread,
  ProjectAgentsConfig,
  SettingsPatch,
  SettingsScope,
  SkillInput,
  SkillScope,
  WorkspaceMeta
} from '../../src/shared/settings-schema'

let mainWindow: BrowserWindow | null = null
let currentWorkspace: string | null = null
let chatAbort: AbortController | null = null
/** True while a chat:stream invoke is in flight (not merely holding the last AbortController). */
let chatStreamActive = false

const isDev = !app.isPackaged

const secretsPath = (): string => join(userDataRoot(), 'secrets.bin')

function storeSecret(key: string, value: string): void {
  mkdirSync(userDataRoot(), { recursive: true })
  let map: Record<string, string> = {}
  if (existsSync(secretsPath())) {
    try {
      const buf = readFileSync(secretsPath())
      if (safeStorage.isEncryptionAvailable()) {
        map = JSON.parse(safeStorage.decryptString(buf))
      } else {
        map = JSON.parse(buf.toString('utf8'))
      }
    } catch {
      map = {}
    }
  }
  map[key] = value
  const payload = JSON.stringify(map)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(secretsPath(), safeStorage.encryptString(payload))
  } else {
    writeFileSync(secretsPath(), payload, 'utf8')
  }
}

function getSecret(key: string): string | null {
  if (!existsSync(secretsPath())) return null
  try {
    const buf = readFileSync(secretsPath())
    const map = safeStorage.isEncryptionAvailable()
      ? (JSON.parse(safeStorage.decryptString(buf)) as Record<string, string>)
      : (JSON.parse(buf.toString('utf8')) as Record<string, string>)
    return map[key] ?? null
  } catch {
    return null
  }
}

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', 'icons', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icons', 'icon.png'),
    join(__dirname, '../../resources/icons/icon.png'),
    join(process.cwd(), 'resources', 'icons', 'icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function createWindow(): void {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1a1b1e',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Eris',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow?.webContents.send('menu:new-workspace')
        },
        {
          label: 'Link Folder as Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open-folder')
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow?.webContents.send('menu:command-palette')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Agent',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow?.webContents.send('menu:new-chat')
        },
        {
          label: 'Stop Generation',
          click: () => {
            chatAbort?.abort()
            mainWindow?.webContents.send('menu:stop-chat')
          }
        }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function mergePulledUserSettings(
  remote: SettingsPatch,
  local: ReturnType<typeof getResolvedSettings>
): SettingsPatch {
  const patch: SettingsPatch = { ...remote }
  if (remote.mcp?.servers) {
    const localById = new Map((local.mcp?.servers || []).map((s) => [s.id, s]))
    patch.mcp = {
      servers: remote.mcp.servers.map((rs) => {
        if (!rs || typeof rs !== 'object' || !('id' in rs)) return rs as never
        const id = String((rs as { id: string }).id)
        const loc = localById.get(id)
        if (!loc) return rs as never
        const env = { ...((rs as { env?: Record<string, string> }).env || {}) }
        for (const [k, v] of Object.entries(loc.env || {})) {
          if (!env[k]) env[k] = v
        }
        return { ...(rs as object), env } as never
      })
    }
  }
  if (remote.models?.connections) {
    const localById = new Map((local.models?.connections || []).map((c) => [c.id, c]))
    patch.models = {
      ...(patch.models || {}),
      connections: remote.models.connections.map((rc) => {
        if (!rc || typeof rc !== 'object' || !('id' in rc)) return rc as never
        const id = String((rc as { id: string }).id)
        const loc = localById.get(id)
        if (!loc?.apiKeyRef) return { ...(rc as object), apiKeyRef: '' } as never
        return { ...(rc as object), apiKeyRef: loc.apiKeyRef } as never
      })
    }
  }
  return patch
}

function registerIpc(): void {
  setWorkspaceFsChangeHandler(({ workspacePath, path }) => {
    invalidateDiagnosticsCache()
    notifyWorkspaceFilesChanged(workspacePath)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workspace:fs-changed', { workspacePath, path })
    }
  })

  const refreshIntelligence = () => {
    disposePtySession()
    void disposeTsLsp()
    if (!currentWorkspace) {
      stopWorkspaceWatcher()
      void disposeMcpRuntime()
      return
    }
    startWorkspaceWatcher(currentWorkspace)
    const settings = getResolvedSettings(currentWorkspace)
    void syncMcpRuntime(settings, currentWorkspace).catch(() => undefined)
    try {
      ensureCodeIndex(currentWorkspace)
    } catch {
      // optional
    }
  }

  ipcMain.handle('app:getState', () => getAppState())
  ipcMain.handle('app:completeOnboarding', () => completeOnboarding())
  ipcMain.handle('app:resetOnboarding', () => resetOnboarding())

  ipcMain.handle('workspace:list', () => listWorkspaces())

  ipcMain.handle('workspace:create', async (_e, name: string) => {
    if (!mainWindow) return null
    const record = await createWorkspaceDialog(mainWindow, name)
    if (record) {
      currentWorkspace = record.path
      refreshIntelligence()
    }
    return record
  })

  ipcMain.handle('workspace:link', async (_e, name?: string) => {
    if (!mainWindow) return null
    const record = await linkWorkspaceDialog(mainWindow, name)
    if (record) {
      currentWorkspace = record.path
      refreshIntelligence()
    }
    return record
  })

  ipcMain.handle('workspace:open', async () => {
    if (!mainWindow) return null
    const path = await openWorkspaceDialog(mainWindow)
    if (path) {
      currentWorkspace = path
      refreshIntelligence()
    }
    return path
  })

  ipcMain.handle('workspace:openPath', (_e, path: string) => {
    if (!existsSync(path)) return null
    currentWorkspace = path
    rememberWorkspace(path)
    refreshIntelligence()
    return path
  })

  ipcMain.handle('workspace:openById', (_e, id: string) => {
    const record = getWorkspaceById(id)
    if (!record || !existsSync(record.path)) return null
    currentWorkspace = record.path
    const remembered = rememberWorkspace(record.path, { id: record.id, name: record.name })
    logInfo('Workspace opened', { id, path: record.path, name: record.name })
    refreshIntelligence()
    return remembered
  })

  ipcMain.handle('workspace:rename', (_e, id: string, name: string) => renameWorkspace(id, name))

  ipcMain.handle('workspace:remove', (_e, id: string) => {
    const record = getWorkspaceById(id)
    const state = removeWorkspace(id)
    if (record && currentWorkspace === record.path) {
      currentWorkspace = null
      stopWorkspaceWatcher()
    }
    return state
  })

  ipcMain.handle('workspace:getCurrent', () => currentWorkspace)

  ipcMain.handle('workspace:setCurrent', (_e, path: string | null) => {
    currentWorkspace = path
    if (path) rememberWorkspace(path)
    refreshIntelligence()
    return currentWorkspace
  })

  ipcMain.handle('workspace:getMeta', (_e, path: string) => getWorkspaceMeta(path))
  ipcMain.handle('workspace:setMeta', (_e, path: string, meta: WorkspaceMeta) =>
    setWorkspaceMeta(path, meta)
  )

  ipcMain.handle('settings:getLayered', () => getLayeredSettings(currentWorkspace))
  ipcMain.handle('settings:getResolved', () => getResolvedSettings(currentWorkspace))
  ipcMain.handle('settings:set', (_e, scope: SettingsScope, patch: SettingsPatch) => {
    const next = setSettings(scope, patch, currentWorkspace)
    if (patch.mcp) refreshIntelligence()
    configureLogger(next)
    logInfo('Settings updated', { scope, keys: Object.keys(patch) })
    return next
  })
  ipcMain.handle('settings:resetKey', (_e, scope: SettingsScope, pathKeys: string[]) => {
    const next = resetSettingKey(scope, pathKeys, currentWorkspace)
    configureLogger(next)
    return next
  })

  ipcMain.handle('logs:info', () => getLogsInfo())
  ipcMain.handle('logs:read', (_e, fileName?: string) => readLogFile({ fileName }))
  ipcMain.handle('logs:clear', () => {
    const result = clearLogs()
    logInfo('Logs cleared', result)
    return result
  })
  ipcMain.handle('logs:openFolder', () => openLogsDirectory())
  ipcMain.handle('logs:pickDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose log folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getLogsInfo().directory
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle(
    'logs:write',
    (_e, level: LogLevel, message: string, meta?: unknown) => {
      log(level, message, meta)
      return true
    }
  )

  ipcMain.handle('secrets:set', (_e, key: string, value: string) => {
    storeSecret(key, value)
    return true
  })
  ipcMain.handle('secrets:get', (_e, key: string) => getSecret(key))

  ipcMain.handle('fs:listTree', (_e, root: string) => listTree(root))
  ipcMain.handle('fs:read', (_e, path: string) => {
    const file = readTextFile(path)
    return { ...file, language: languageFromPath(path) }
  })
  ipcMain.handle('fs:write', (_e, path: string, content: string) => {
    writeTextFile(path, content)
    return true
  })
  ipcMain.handle('fs:pickFiles', async () => {
    if (!mainWindow) return [] as string[]
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import files for agent',
      properties: ['openFile', 'multiSelections'],
      defaultPath: currentWorkspace ?? undefined
    })
    if (result.canceled) return [] as string[]
    return result.filePaths
  })

  ipcMain.handle('models:status', async () => {
    const settings = getResolvedSettings(currentWorkspace)
    const status = await getModelsStatus(settings, getSecret)
    // Keep connection.models in sync with live Ollama/API lists so chat can route by model id.
    const { connections, changed } = connectionsWithDiscoveredModels(settings, status)
    if (changed) {
      setSettings('user', { models: { connections } }, currentWorkspace)
      return {
        ...status,
        connections: status.connections.map((c) => {
          const updated = connections.find((u) => u.id === c.id)
          return updated ? { ...c, models: updated.models } : c
        })
      }
    }
    return status
  })

  ipcMain.handle('models:builtinStatus', () => getBuiltinStatuses())

  ipcMain.handle('models:downloadBuiltin', async (event, id: string) => {
    const modelId = id || 'composer-lite'
    logInfo('Builtin model download start', { id: modelId })
    try {
      const status = await downloadBuiltinModel(modelId, (progress) => {
        event.sender.send('models:downloadProgress', progress)
      })
      logInfo('Builtin model download complete', { id: modelId, ready: status.ready })
      return status
    } catch (err) {
      logError('Builtin model download failed', {
        id: modelId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  })

  ipcMain.handle('models:cancelDownload', () => {
    cancelBuiltinDownload()
    logWarn('Builtin model download cancelled')
    return true
  })

  ipcMain.handle('models:deleteBuiltin', (_e, id: string) => {
    return deleteBuiltinModel(id || 'composer-lite')
  })

  ipcMain.handle('models:verifyBuiltin', async (_e, id: string) => {
    return verifyBuiltinModel(id || 'composer-lite')
  })

  ipcMain.handle('chats:list', () => listChats(currentWorkspace))
  ipcMain.handle('chats:get', (_e, id: string) => getChat(currentWorkspace, id))
  ipcMain.handle('chats:create', (_e, model: string) => {
    const thread = createChat(currentWorkspace, model)
    logInfo('Chat created', { id: thread.id, model })
    return thread
  })
  ipcMain.handle('chats:save', (_e, thread: ChatThread) => saveChat(currentWorkspace, thread))
  ipcMain.handle('chats:delete', (_e, id: string) => {
    deleteChat(currentWorkspace, id)
    logInfo('Chat deleted', { id })
    return true
  })
  ipcMain.handle('chats:rules', () => loadWorkspaceRules(currentWorkspace))

  ipcMain.handle('skills:list', () => {
    ensureSkillsDirs(currentWorkspace)
    return listSkills(currentWorkspace)
  })
  ipcMain.handle('skills:get', (_e, id: string, scope?: SkillScope) =>
    getSkill(currentWorkspace, id, scope)
  )
  ipcMain.handle('skills:create', (_e, input: SkillInput) => {
    ensureSkillsDirs(currentWorkspace)
    const skill = createSkill(currentWorkspace, input)
    logInfo('Skill created', { id: skill.id, scope: skill.scope })
    return skill
  })
  ipcMain.handle(
    'skills:update',
    (
      _e,
      id: string,
      scope: SkillScope,
      patch: Partial<Pick<SkillInput, 'name' | 'description' | 'body'>>
    ) => {
      const skill = updateSkill(currentWorkspace, id, scope, patch)
      logInfo('Skill updated', { id: skill.id, scope: skill.scope })
      return skill
    }
  )
  ipcMain.handle('skills:delete', (_e, id: string, scope: SkillScope) => {
    const ok = deleteSkill(currentWorkspace, id, scope)
    if (ok) logInfo('Skill deleted', { id, scope })
    return ok
  })
  ipcMain.handle('skills:prompt', (_e, ids: string[]) =>
    loadSkillsPrompt(currentWorkspace, ids)
  )

  ipcMain.handle(
    'agents:route',
    async (
      _e,
      payload: { text: string; fileNames: string[]; manualAgentId?: string | null }
    ) => {
      const settings = getResolvedSettings(currentWorkspace)
      return routeMessage({
        workspacePath: currentWorkspace,
        settings,
        text: payload.text,
        fileNames: payload.fileNames ?? [],
        manualAgentId: payload.manualAgentId
      })
    }
  )

  ipcMain.handle('agents:list', () => {
    const settings = getResolvedSettings(currentWorkspace)
    return listResolvedAgents(currentWorkspace, settings)
  })

  ipcMain.handle('agents:getProject', () => {
    if (currentWorkspace) seedProjectAgents(currentWorkspace, false)
    return getProjectAgents(currentWorkspace)
  })

  ipcMain.handle('agents:saveProject', (_e, config: ProjectAgentsConfig) => {
    if (!currentWorkspace) {
      throw new Error('Open a workspace to edit project agents')
    }
    return saveProjectAgents(currentWorkspace, config)
  })

  ipcMain.handle('agents:resetProject', () => {
    if (!currentWorkspace) {
      throw new Error('Open a workspace to reset project agents')
    }
    return seedProjectAgents(currentWorkspace, true)
  })

  const completeControllers = new Map<string, AbortController>()
  const abortAllCompletes = () => {
    for (const [id, ac] of completeControllers) {
      ac.abort()
      completeControllers.delete(id)
    }
  }

  ipcMain.handle(
    'chat:stream',
    async (
      event,
      payload: {
        requestId: string
        model: string
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
        agentId?: string
        mode?: 'ask' | 'agent'
      }
    ) => {
      const settings = getResolvedSettings(currentWorkspace)
      chatAbort?.abort()
      chatAbort = new AbortController()
      chatStreamActive = true
      // Ghost completes share the llama runtime — never race the agent turn.
      abortAllCompletes()
      const { requestId, model, messages, agentId, mode } = payload
      const agent = agentId ? findAgent(currentWorkspace, agentId) : null
      const resolvedModel =
        model || agent?.model.trim() || settings.models.defaultModel
      const temperature =
        agent?.temperature ?? settings.models.temperature
      setDiagnosticsPaused(true)
      // Coalesce high-frequency thinking/answer IPC (~40ms) to cut renderer thrash.
      let pendingThinking = ''
      let pendingAnswer = ''
      let coalesceTimer: ReturnType<typeof setTimeout> | null = null
      const flushStreamChunks = () => {
        if (coalesceTimer) {
          clearTimeout(coalesceTimer)
          coalesceTimer = null
        }
        if (pendingThinking) {
          event.sender.send('chat:thinking', { requestId, chunk: pendingThinking })
          pendingThinking = ''
        }
        if (pendingAnswer) {
          event.sender.send('chat:answer', { requestId, chunk: pendingAnswer })
          pendingAnswer = ''
        }
      }
      const scheduleStreamFlush = () => {
        if (coalesceTimer) return
        coalesceTimer = setTimeout(flushStreamChunks, 40)
      }
      try {
        logInfo('Chat stream start', {
          requestId,
          model: resolvedModel,
          agentId: agent?.id ?? agentId,
          mode: mode ?? 'agent',
          messages: messages.length
        })
        event.sender.send('chat:routed', {
          requestId,
          agentId: agent?.id ?? agentId,
          agentName: agent?.name,
          model: resolvedModel
        })

        for await (const evt of runAgentWithWorkspaceTools({
          workspacePath: currentWorkspace,
          settings,
          model: resolvedModel,
          messages,
          temperature,
          signal: chatAbort.signal,
          getSecret,
          mode: mode ?? 'agent'
        })) {
          if (evt.type === 'thinking') {
            pendingThinking += evt.text
            scheduleStreamFlush()
          } else if (evt.type === 'answer') {
            pendingAnswer += evt.text
            scheduleStreamFlush()
          } else {
            flushStreamChunks()
            if (evt.type === 'tool') {
              event.sender.send('chat:tool', { requestId, tool: evt.tool })
            } else if (evt.type === 'diff') {
              event.sender.send('chat:diff', { requestId, diff: evt.diff })
            } else if (evt.type === 'checkpoint') {
              event.sender.send('chat:checkpoint', {
                requestId,
                checkpointId: evt.checkpointId
              })
            } else if (evt.type === 'terminal') {
              event.sender.send('chat:terminal', { requestId, text: evt.text })
            } else if (evt.type === 'workspace-changed') {
              event.sender.send('chat:workspace-changed', { requestId })
            } else if (evt.type === 'status') {
              event.sender.send('chat:status', { requestId, text: evt.text })
            } else if (evt.type === 'model') {
              event.sender.send('chat:model', {
                requestId,
                model: evt.model,
                agentId: agent?.id ?? agentId,
                agentName: agent?.name
              })
            }
          }
        }
        flushStreamChunks()
        event.sender.send('chat:done', { requestId })
        logInfo('Chat stream done', { requestId, model: resolvedModel })
        return true
      } catch (err) {
        flushStreamChunks()
        if ((err as Error).name === 'AbortError') {
          logWarn('Chat stream aborted', { requestId })
          event.sender.send('chat:done', { requestId, aborted: true })
          return false
        }
        const message = err instanceof Error ? err.message : 'Chat failed'
        logError('Chat stream failed', { requestId, model: resolvedModel, error: message })
        event.sender.send('chat:error', {
          requestId,
          error: message
        })
        // Don't rethrow — returning keeps the renderer invoke from rejecting as an unhandled crash
        return false
      } finally {
        if (coalesceTimer) clearTimeout(coalesceTimer)
        setDiagnosticsPaused(false)
        chatStreamActive = false
      }
    }
  )

  ipcMain.handle('chat:stop', () => {
    if (chatAbort) {
      chatAbort.abort()
      // Keep the controller so in-flight code still sees signal.aborted === true.
      // A new stream replaces it on the next chat:stream.
    }
    return true
  })

  ipcMain.handle('checkpoint:restore', (_e, checkpointId: string) => {
    if (!currentWorkspace) throw new Error('No workspace open')
    return restoreCheckpoint(currentWorkspace, checkpointId)
  })

  ipcMain.handle(
    'checkpoint:restoreOp',
    (_e, checkpointId: string, opIndex: number) => {
      if (!currentWorkspace) throw new Error('No workspace open')
      return restoreCheckpointOp(currentWorkspace, checkpointId, opIndex)
    }
  )

  ipcMain.handle('terminal:run', async (e, command: string) => {
    if (!currentWorkspace) throw new Error('No workspace open')
    const sender = e.sender
    return runWorkspaceCommand(currentWorkspace, command, {
      onChunk: (chunk, stream) => {
        if (!sender.isDestroyed()) {
          sender.send('terminal:data', { chunk, stream })
        }
      }
    })
  })

  onPtyData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', data)
    }
  })
  onPtyExit((info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', info)
    }
  })
  onLspDiagnostics((items) => {
    if (!mainWindow || mainWindow.isDestroyed() || !items.length) return
    const path = items[0]!.path
    mainWindow.webContents.send('lsp:diagnostics', { path, diagnostics: items })
  })

  ipcMain.handle(
    'pty:ensure',
    (_e, size?: { cols?: number; rows?: number }) => {
      if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
      return ensurePtySession(currentWorkspace, size?.cols ?? 80, size?.rows ?? 24)
    }
  )
  ipcMain.handle('pty:write', (_e, data: string) => writePty(String(data ?? '')))
  ipcMain.handle(
    'pty:resize',
    (_e, size: { cols: number; rows: number }) =>
      resizePty(Number(size?.cols) || 80, Number(size?.rows) || 24)
  )
  ipcMain.handle('pty:kill', () => {
    disposePtySession()
    return { ok: true }
  })

  ipcMain.handle(
    'lsp:didOpen',
    async (
      _e,
      payload: { path: string; language: string; text: string }
    ) => {
      if (!currentWorkspace) return { ok: false }
      await lspDidOpen(currentWorkspace, payload.path, payload.language, payload.text)
      return { ok: true }
    }
  )
  ipcMain.handle(
    'lsp:didChange',
    async (
      _e,
      payload: { path: string; language: string; text: string }
    ) => {
      if (!currentWorkspace) return { ok: false }
      await lspDidChange(currentWorkspace, payload.path, payload.language, payload.text)
      return { ok: true }
    }
  )
  ipcMain.handle('lsp:didClose', async (_e, path: string) => {
    await lspDidClose(path)
    return { ok: true }
  })
  ipcMain.handle(
    'lsp:hover',
    async (
      _e,
      payload: { path: string; line: number; character: number }
    ) => {
      if (!currentWorkspace) return { ok: false, contents: '' }
      return lspHover(
        currentWorkspace,
        payload.path,
        payload.line,
        payload.character
      )
    }
  )
  ipcMain.handle(
    'lsp:definition',
    async (
      _e,
      payload: { path: string; line: number; character: number }
    ) => {
      if (!currentWorkspace) return { ok: false, locations: [] }
      return lspDefinition(
        currentWorkspace,
        payload.path,
        payload.line,
        payload.character
      )
    }
  )
  ipcMain.handle(
    'lsp:completion',
    async (
      _e,
      payload: { path: string; line: number; character: number }
    ) => {
      if (!currentWorkspace) return { ok: false, items: [] }
      return lspCompletion(
        currentWorkspace,
        payload.path,
        payload.line,
        payload.character
      )
    }
  )

  ipcMain.handle('git:status', async () => {
    if (!currentWorkspace) {
      return {
        ok: false,
        error: 'No workspace open',
        branch: null,
        ahead: 0,
        behind: 0,
        entries: []
      }
    }
    return gitStatus(currentWorkspace)
  })

  ipcMain.handle('git:diff', async (_e, path?: string) => {
    if (!currentWorkspace) return { ok: false, diff: '', error: 'No workspace open' }
    return gitDiff(currentWorkspace, path)
  })

  ipcMain.handle('git:stage', async (_e, paths: string[]) => {
    if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
    return gitStage(currentWorkspace, paths)
  })

  ipcMain.handle('git:commit', async (_e, message: string) => {
    if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
    return gitCommit(currentWorkspace, message)
  })

  ipcMain.handle('git:branches', async () => {
    if (!currentWorkspace) {
      return { ok: false, current: null, branches: [], error: 'No workspace open' }
    }
    return gitBranches(currentWorkspace)
  })

  ipcMain.handle(
    'git:checkout',
    async (_e, payload: { branch: string; create?: boolean }) => {
      if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
      return gitCheckout(currentWorkspace, payload.branch, Boolean(payload.create))
    }
  )

  ipcMain.handle(
    'git:stash',
    async (_e, payload?: { action?: 'push' | 'pop' | 'list'; message?: string }) => {
      if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
      return gitStash(
        currentWorkspace,
        payload?.action || 'push',
        payload?.message
      )
    }
  )

  ipcMain.handle('github:listPullRequests', async () => {
    if (!currentWorkspace) return { ok: false, error: 'No workspace open', pullRequests: [] }
    const settings = getResolvedSettings(currentWorkspace)
    const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
    const ref = parseGithubRepo(settings.github.repository, settings.github.host)
    if (!token || !ref) {
      return { ok: false, error: 'Link a GitHub repo and add a token first', pullRequests: [] }
    }
    return listGithubPullRequests({
      host: ref.host,
      token,
      owner: ref.owner,
      repo: ref.repo
    })
  })

  ipcMain.handle(
    'github:createPullRequest',
    async (
      _e,
      payload: { title: string; body?: string; head?: string; base?: string; draft?: boolean }
    ) => {
      if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
      const settings = getResolvedSettings(currentWorkspace)
      const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
      const ref = parseGithubRepo(settings.github.repository, settings.github.host)
      if (!token || !ref) {
        return { ok: false, error: 'Link a GitHub repo and add a token first' }
      }
      const status = await gitStatus(currentWorkspace)
      const head = payload.head || status.branch
      const base = payload.base || settings.github.defaultBranch || 'main'
      if (!head) return { ok: false, error: 'Could not determine current branch' }
      if (!payload.title?.trim()) return { ok: false, error: 'PR title required' }
      return createGithubPullRequest({
        host: ref.host,
        token,
        owner: ref.owner,
        repo: ref.repo,
        title: payload.title.trim(),
        body: payload.body,
        head,
        base,
        draft: payload.draft
      })
    }
  )

  ipcMain.handle('github:status', async () => {
    const settings = getResolvedSettings(currentWorkspace)
    return buildLinkState(currentWorkspace, settings, getSecret)
  })

  ipcMain.handle('github:testToken', async (_e, token?: string) => {
    const settings = getResolvedSettings(currentWorkspace)
    const value =
      (typeof token === 'string' && token.trim()) ||
      (settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null)
    if (!value) return { ok: false, error: 'No GitHub token configured' }
    return testGithubToken(settings.github.host, value)
  })

  ipcMain.handle(
    'github:link',
    async (
      _e,
      payload: {
        repository: string
        remoteName?: string
        defaultBranch?: string
        preferredProtocol?: 'https' | 'ssh'
        host?: string
        setGitRemote?: boolean
      }
    ) => {
      if (!currentWorkspace) return { ok: false, error: 'Open a workspace to link GitHub' }
      const settings = getResolvedSettings(currentWorkspace)
      const host = payload.host || settings.github.host
      const ref = parseGithubRepo(payload.repository, host)
      if (!ref) {
        return {
          ok: false,
          error: 'Enter owner/repo or a GitHub URL (e.g. acme/app or https://github.com/acme/app)'
        }
      }
      const remoteName = payload.remoteName || settings.github.remoteName || 'origin'
      const preferredProtocol = payload.preferredProtocol || settings.github.preferredProtocol
      const cloneUrl =
        preferredProtocol === 'ssh' ? cloneUrlSsh(ref) : cloneUrlHttps(ref)

      if (payload.setGitRemote !== false) {
        const remote = await setRemoteUrl(currentWorkspace, remoteName, cloneUrl)
        if (!remote.ok) return remote
      }

      // Host/protocol stay user-scoped; repo link is workspace-scoped
      setSettings(
        'user',
        {
          github: {
            host: ref.host,
            preferredProtocol
          }
        },
        currentWorkspace
      )
      setSettings(
        'workspace',
        {
          github: {
            repository: `${ref.owner}/${ref.repo}`,
            remoteName,
            defaultBranch: payload.defaultBranch || settings.github.defaultBranch || 'main',
            linked: true
          }
        },
        currentWorkspace
      )
      return buildLinkState(currentWorkspace, getResolvedSettings(currentWorkspace), getSecret)
    }
  )

  ipcMain.handle('github:unlink', async () => {
    if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
    setSettings(
      'workspace',
      {
        github: {
          repository: '',
          linked: false
        }
      },
      currentWorkspace
    )
    return buildLinkState(currentWorkspace, getResolvedSettings(currentWorkspace), getSecret)
  })

  ipcMain.handle('github:detectRemote', async () => {
    if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
    const settings = getResolvedSettings(currentWorkspace)
    const ref = await detectGithubFromRemote(
      currentWorkspace,
      settings.github.remoteName || 'origin',
      settings.github.host
    )
    if (!ref) return { ok: false, error: 'No GitHub remote found on origin' }
    return {
      ok: true,
      repository: `${ref.owner}/${ref.repo}`,
      host: ref.host,
      pageUrl: repoPageUrl(ref)
    }
  })

  ipcMain.handle('github:open', async (_e, which?: 'page' | 'issues' | 'prs' | 'actions') => {
    const settings = getResolvedSettings(currentWorkspace)
    const state = await buildLinkState(currentWorkspace, settings, getSecret)
    if (!state.pageUrl) return { ok: false, error: 'No linked GitHub repository' }
    const suffix =
      which === 'issues'
        ? '/issues'
        : which === 'prs'
          ? '/pulls'
          : which === 'actions'
            ? '/actions'
            : ''
    await shell.openExternal(`${state.pageUrl}${suffix}`)
    return { ok: true, url: `${state.pageUrl}${suffix}` }
  })

  ipcMain.handle(
    'github:sync',
    async (_e, action: 'fetch' | 'pull' | 'push') => {
      if (!currentWorkspace) return { ok: false, error: 'No workspace open' }
      const settings = getResolvedSettings(currentWorkspace)
      const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
      const ref = settings.github.repository
        ? parseGithubRepo(settings.github.repository, settings.github.host)
        : await detectGithubFromRemote(
            currentWorkspace,
            settings.github.remoteName || 'origin',
            settings.github.host
          )
      const branchRes = await gitStatus(currentWorkspace)
      return pushPullFetch(
        currentWorkspace,
        action,
        settings.github.remoteName || 'origin',
        branchRes.branch,
        token,
        ref,
        settings.github.preferredProtocol
      )
    }
  )

  ipcMain.handle(
    'github:createRepo',
    async (
      _e,
      payload: {
        name: string
        description?: string
        privateRepo?: boolean
        autoInit?: boolean
        link?: boolean
      }
    ) => {
      if (!currentWorkspace) return { ok: false, error: 'Open a workspace first' }
      const settings = getResolvedSettings(currentWorkspace)
      const token = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null
      if (!token) return { ok: false, error: 'Add a GitHub personal access token first' }
      const created = await createGithubRepository({
        host: settings.github.host,
        token,
        name: payload.name,
        description: payload.description,
        privateRepo: payload.privateRepo,
        autoInit: payload.autoInit
      })
      if (!created.ok || !created.fullName) return created
      if (payload.link !== false) {
        const ref = parseGithubRepo(created.fullName, settings.github.host)!
        const url =
          settings.github.preferredProtocol === 'ssh'
            ? cloneUrlSsh(ref)
            : cloneUrlHttps(ref)
        await setRemoteUrl(currentWorkspace, settings.github.remoteName || 'origin', url)
        setSettings(
          'workspace',
          {
            github: {
              repository: created.fullName,
              linked: true,
              remoteName: settings.github.remoteName || 'origin',
              defaultBranch: settings.github.defaultBranch || 'main'
            }
          },
          currentWorkspace
        )
      }
      return {
        ...created,
        link: await buildLinkState(
          currentWorkspace,
          getResolvedSettings(currentWorkspace),
          getSecret
        )
      }
    }
  )

  ipcMain.handle('github:setToken', async (_e, token: string) => {
    const ref = 'github.pat'
    if (!token.trim()) {
      setSettings('user', { github: { tokenRef: '' } }, currentWorkspace)
      return { ok: true, cleared: true }
    }
    storeSecret(ref, token.trim())
    setSettings('user', { github: { tokenRef: ref } }, currentWorkspace)
    const checked = await testGithubToken(
      getResolvedSettings(currentWorkspace).github.host,
      token.trim()
    )
    return { ok: checked.ok, login: checked.login, error: checked.error, cleared: false }
  })

  ipcMain.handle('ericServices:status', async () => {
    const settings = getResolvedSettings(currentWorkspace)
    const token = settings.ericServices.tokenRef
      ? getSecret(settings.ericServices.tokenRef)
      : null
    const base = buildEricServicesStatus(settings, Boolean(token))
    if (!token || !settings.ericServices.linked) return base
    const me = await ericServicesFetchMe(settings.ericServices.apiBase, token)
    if (!me.ok) {
      return { ...base, ok: false, error: me.error }
    }
    if (me.profile) {
      setSettings(
        'user',
        {
          ericServices: {
            username: me.profile.username || settings.ericServices.username,
            email: me.profile.email || settings.ericServices.email
          }
        },
        currentWorkspace
      )
    }
    return {
      ...buildEricServicesStatus(getResolvedSettings(currentWorkspace), true),
      profile: me.profile ?? null
    }
  })

  ipcMain.handle(
    'ericServices:login',
    async (
      _e,
      payload: { username: string; password: string; apiBase?: string; syncAfter?: boolean }
    ) => {
      const settings = getResolvedSettings(currentWorkspace)
      const apiBase = payload.apiBase?.trim() || settings.ericServices.apiBase
      const username = payload.username?.trim() || ''
      const password = payload.password || ''
      if (!username || !password) {
        return { ok: false, error: 'Username and password are required' }
      }
      const result = await ericServicesLogin(apiBase, username, password, 'Eris')
      if (!result.ok || !result.token) {
        return { ok: false, error: result.error || 'Login failed' }
      }
      const ref = ericServicesTokenRef()
      storeSecret(ref, result.token)
      setSettings(
        'user',
        {
          ericServices: {
            apiBase,
            tokenRef: ref,
            linked: true,
            username: result.profile?.username || username,
            email: result.profile?.email || ''
          }
        },
        currentWorkspace
      )

      let sync: { ok: boolean; error?: string; direction?: string } | undefined
      if (payload.syncAfter !== false && settings.ericServices.syncEnabled !== false) {
        sync = await syncEricServicesProfile('pull')
        if (!sync.ok) {
          // Push local prefs if nothing remote yet
          sync = await syncEricServicesProfile('push')
        }
      }

      return {
        ok: true,
        profile: result.profile,
        status: buildEricServicesStatus(getResolvedSettings(currentWorkspace), true, {
          profile: result.profile ?? null
        }),
        sync
      }
    }
  )

  ipcMain.handle('ericServices:logout', async () => {
    const settings = getResolvedSettings(currentWorkspace)
    const token = settings.ericServices.tokenRef
      ? getSecret(settings.ericServices.tokenRef)
      : null
    if (token) {
      await ericServicesLogout(settings.ericServices.apiBase, token).catch(() => undefined)
    }
    storeSecret(ericServicesTokenRef(), '')
    setSettings(
      'user',
      {
        ericServices: {
          tokenRef: '',
          linked: false,
          username: '',
          email: '',
          lastSyncedAt: ''
        }
      },
      currentWorkspace
    )
    return buildEricServicesStatus(getResolvedSettings(currentWorkspace), false)
  })

  async function syncEricServicesProfile(
    direction: 'pull' | 'push' | 'bidirectional'
  ): Promise<{
    ok: boolean
    error?: string
    direction?: string
    updatedAt?: string | null
    status?: ReturnType<typeof buildEricServicesStatus>
  }> {
    const settings = getResolvedSettings(currentWorkspace)
    const token = settings.ericServices.tokenRef
      ? getSecret(settings.ericServices.tokenRef)
      : null
    if (!token || !settings.ericServices.linked) {
      return { ok: false, error: 'Sign in to EricServic.es first' }
    }

    if (direction === 'pull' || direction === 'bidirectional') {
      const remote = await ericServicesPullSettings(settings.ericServices.apiBase, token)
      if (!remote.ok) return { ok: false, error: remote.error, direction: 'pull' }
      const applied = applyProfileBundle(remote.bundle)
      const settingsPatch = applied.settings || remote.settings
      if (settingsPatch && Object.keys(settingsPatch).length > 0) {
        const localResolved = getResolvedSettings(currentWorkspace)
        setSettings(
          'user',
          mergePulledUserSettings(settingsPatch, localResolved),
          currentWorkspace
        )
        setSettings(
          'user',
          {
            ericServices: {
              lastSyncedAt: remote.updatedAt || new Date().toISOString()
            }
          },
          currentWorkspace
        )
        void syncMcpRuntime(getResolvedSettings(currentWorkspace), currentWorkspace).catch(
          () => undefined
        )
        return {
          ok: true,
          direction: 'pull',
          updatedAt: remote.updatedAt,
          status: buildEricServicesStatus(getResolvedSettings(currentWorkspace), true)
        }
      }
      if (applied.skillsImported > 0) {
        setSettings(
          'user',
          {
            ericServices: {
              lastSyncedAt: remote.updatedAt || new Date().toISOString()
            }
          },
          currentWorkspace
        )
        return {
          ok: true,
          direction: 'pull',
          updatedAt: remote.updatedAt,
          status: buildEricServicesStatus(getResolvedSettings(currentWorkspace), true)
        }
      }
      if (direction === 'pull') {
        return {
          ok: true,
          direction: 'pull',
          updatedAt: null,
          status: buildEricServicesStatus(getResolvedSettings(currentWorkspace), true)
        }
      }
    }

    const resolved = getResolvedSettings(currentWorkspace)
    const local = buildSyncableSettings(resolved)
    const bundle = buildProfileBundle(resolved)
    const pushed = await ericServicesPushSettings(
      settings.ericServices.apiBase,
      token,
      local,
      settings.ericServices.lastSyncedAt || null,
      bundle
    )
    if (!pushed.ok) {
      // Conflict: remote newer — pull instead when bidirectional
      if (direction === 'bidirectional' && (pushed.bundle || pushed.settings)) {
        const applied = applyProfileBundle(pushed.bundle)
        const settingsPatch = applied.settings || pushed.settings
        if (settingsPatch) {
          const localResolved = getResolvedSettings(currentWorkspace)
          setSettings(
            'user',
            mergePulledUserSettings(settingsPatch, localResolved),
            currentWorkspace
          )
        }
        setSettings(
          'user',
          {
            ericServices: {
              lastSyncedAt: pushed.updatedAt || new Date().toISOString()
            }
          },
          currentWorkspace
        )
        void syncMcpRuntime(getResolvedSettings(currentWorkspace), currentWorkspace).catch(
          () => undefined
        )
        return {
          ok: true,
          direction: 'pull',
          updatedAt: pushed.updatedAt,
          status: buildEricServicesStatus(getResolvedSettings(currentWorkspace), true)
        }
      }
      return { ok: false, error: pushed.error, direction: 'push' }
    }
    setSettings(
      'user',
      {
        ericServices: {
          lastSyncedAt: pushed.updatedAt || new Date().toISOString()
        }
      },
      currentWorkspace
    )
    return {
      ok: true,
      direction: 'push',
      updatedAt: pushed.updatedAt,
      status: buildEricServicesStatus(getResolvedSettings(currentWorkspace), true)
    }
  }

  ipcMain.handle(
    'ericServices:sync',
    async (_e, direction?: 'pull' | 'push' | 'bidirectional') => {
      return syncEricServicesProfile(direction || 'bidirectional')
    }
  )

  ipcMain.handle('ericServices:openAccount', async () => {
    const settings = getResolvedSettings(currentWorkspace)
    const base = settings.ericServices.apiBase.replace(/\/+$/, '')
    const url = settings.ericServices.linked
      ? `${base}/account/update.php`
      : `${base}/loginform.php`
    await shell.openExternal(url)
    return { ok: true, url }
  })

  ipcMain.handle('mcp:status', async () => {
    if (currentWorkspace) {
      await syncMcpRuntime(getResolvedSettings(currentWorkspace), currentWorkspace).catch(
        () => undefined
      )
    }
    return {
      servers: getMcpStatuses(),
      tools: listMcpTools()
    }
  })

  ipcMain.handle('mcp:reconnect', async () => {
    if (!currentWorkspace) return { servers: [], tools: [] }
    await syncMcpRuntime(getResolvedSettings(currentWorkspace), currentWorkspace)
    return { servers: getMcpStatuses(), tools: listMcpTools() }
  })

  ipcMain.handle(
    'search:grep',
    async (_e, pattern: string, glob?: string) => {
      if (!currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
      return workspaceGrep(currentWorkspace, pattern, { glob })
    }
  )

  ipcMain.handle('search:glob', (_e, pattern: string) => {
    if (!currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return workspaceGlob(currentWorkspace, pattern)
  })

  ipcMain.handle('search:symbols', (_e, query: string) => {
    if (!currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
    return findSymbols(currentWorkspace, query)
  })

  ipcMain.handle('search:retrieve', async (_e, query: string) => {
    if (!currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return retrieveContextAsync(currentWorkspace, query)
  })

  ipcMain.handle('index:rebuild', async () => {
    if (!currentWorkspace) return { ok: false, files: 0, symbols: 0 }
    const record = await buildCodeIndexAsync(currentWorkspace)
    return { ok: true, files: record.files.length, symbols: record.symbols.length }
  })

  ipcMain.handle(
    'ai:complete',
    async (
      _e,
      payload: {
        path: string
        language: string
        prefix: string
        suffix: string
        requestId?: string
      }
    ) => {
      // Don't steal the llama sequence while Composer is streaming.
      if (chatStreamActive) {
        return { ok: false, error: 'Busy', requestId: payload.requestId }
      }
      const settings = getResolvedSettings(currentWorkspace)
      const requestId = payload.requestId || `complete-${Date.now()}`
      abortAllCompletes()
      const ac = new AbortController()
      completeControllers.set(requestId, ac)
      try {
        const result = await completeAtCursor({
          settings,
          getSecret,
          path: payload.path,
          language: payload.language,
          prefix: payload.prefix,
          suffix: payload.suffix,
          signal: ac.signal
        })
        return { ...result, requestId }
      } finally {
        completeControllers.delete(requestId)
      }
    }
  )

  ipcMain.handle('ai:completeCancel', (_e, requestId?: string) => {
    if (requestId) {
      completeControllers.get(requestId)?.abort()
      completeControllers.delete(requestId)
    } else {
      abortAllCompletes()
    }
    return { ok: true }
  })

  ipcMain.handle(
    'ai:inlineEdit',
    async (
      _e,
      payload: {
        path: string
        language: string
        selection: string
        instruction: string
        before?: string
        after?: string
      }
    ) => {
      const settings = getResolvedSettings(currentWorkspace)
      return inlineEdit({
        settings,
        getSecret,
        path: payload.path,
        language: payload.language,
        selection: payload.selection,
        instruction: payload.instruction,
        before: payload.before,
        after: payload.after
      })
    }
  )

  ipcMain.handle('diagnostics:get', async () => {
    if (!currentWorkspace) return { ok: true, diagnostics: [], detail: 'No workspace' }
    return collectDiagnostics(currentWorkspace)
  })

  ipcMain.handle('language:hover', (_e, filePath: string, word: string) => {
    if (!currentWorkspace) return { ok: true, contents: '' }
    return languageHover(currentWorkspace, filePath, word)
  })

  ipcMain.handle('language:definition', (_e, word: string) => {
    if (!currentWorkspace) return { ok: true, locations: [] }
    return goToDefinition(currentWorkspace, word)
  })

  ipcMain.handle('verify:run', async () => {
    if (!currentWorkspace) return { ok: false, command: '', detail: 'No workspace' }
    return runVerify(currentWorkspace)
  })

  ipcMain.handle('debug:listConfigs', () => {
    if (!currentWorkspace) return []
    return listLaunchConfigs(currentWorkspace)
  })

  ipcMain.handle('debug:saveConfigs', (_e, configs: LaunchConfig[]) => {
    if (!currentWorkspace) throw new Error('No workspace')
    saveLaunchConfigs(currentWorkspace, configs)
    return listLaunchConfigs(currentWorkspace)
  })

  ipcMain.handle('debug:listBreakpoints', () => {
    if (!currentWorkspace) return []
    return listBreakpoints(currentWorkspace)
  })

  ipcMain.handle(
    'debug:saveBreakpoints',
    (_e, bps: Array<{ id: string; path: string; line: number; enabled: boolean }>) => {
      if (!currentWorkspace) throw new Error('No workspace')
      saveBreakpoints(currentWorkspace, bps)
      return listBreakpoints(currentWorkspace)
    }
  )

  ipcMain.handle('debug:state', () => getDebugState())

  ipcMain.handle('debug:start', async (_e, configId: string, activeFile?: string | null) => {
    if (!currentWorkspace) throw new Error('No workspace open')
    const configs = listLaunchConfigs(currentWorkspace)
    const config = configs.find((c) => c.id === configId) || configs[0]
    if (!config) throw new Error('No launch configuration')
    return startDebug({
      workspacePath: currentWorkspace,
      config,
      activeFile: activeFile ?? null
    })
  })

  ipcMain.handle('debug:stop', () => stopDebug())
  ipcMain.handle('debug:continue', () => debugContinue())
  ipcMain.handle('debug:stepOver', () => debugStepOver())
  ipcMain.handle('debug:stepInto', () => debugStepInto())
  ipcMain.handle('debug:stepOut', () => debugStepOut())

  // Push debug state updates to all windows
  onDebugState((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('debug:state', state)
    }
  })

  ipcMain.handle('rules:list', () => listRules(currentWorkspace))
  ipcMain.handle(
    'rules:save',
    (_e, name: string, body: string, previousId?: string) => {
      if (!currentWorkspace) throw new Error('Open a workspace to edit rules')
      return saveRule(currentWorkspace, name, body, previousId)
    }
  )
  ipcMain.handle('rules:delete', (_e, id: string) => {
    if (!currentWorkspace) throw new Error('Open a workspace to edit rules')
    return deleteRule(currentWorkspace, id)
  })

  ipcMain.handle('context:get', () => getWorkspaceContext(currentWorkspace))
  ipcMain.handle('context:pin', () => formatWorkspaceContextPrompt(currentWorkspace))
  ipcMain.handle('context:save', (_e, body: string) => {
    if (!currentWorkspace) throw new Error('Open a workspace to edit context')
    return saveWorkspaceContext(currentWorkspace, String(body ?? ''))
  })
  ipcMain.handle('context:setSummary', (_e, summary: string) => {
    if (!currentWorkspace) throw new Error('Open a workspace to edit context')
    return setContextSummary(currentWorkspace, String(summary ?? ''))
  })
  ipcMain.handle('context:appendNote', (_e, note: string) => {
    if (!currentWorkspace) throw new Error('Open a workspace to edit context')
    return appendContextNote(currentWorkspace, String(note ?? ''))
  })

  ipcMain.handle('email:discoverSources', async (_e, emlFolder?: string) => {
    return discoverEmailSources(emlFolder)
  })

  ipcMain.handle('email:pickEmlFolder', async () => {
    if (!mainWindow) return { ok: false, path: null as string | null }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose folder of .eml exports',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, path: null as string | null }
    }
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle(
    'email:pull',
    async (
      _e,
      payload: {
        sourceId: string
        query?: string
        maxMessages?: number
        appendToContext?: boolean
      }
    ) => {
      return pullEmailContext(currentWorkspace, {
        sourceId: payload.sourceId,
        query: payload.query,
        maxMessages: payload.maxMessages,
        appendToContext: payload.appendToContext
      })
    }
  )

  ipcMain.handle('email:readPulled', () => readPulledEmailContext(currentWorkspace))

  ipcMain.handle('usage:get', (_e, days?: number) => getUsageSnapshot(days ?? 7))
  ipcMain.handle('usage:clear', (_e, payload?: { todayOnly?: boolean }) =>
    clearUsageStats({ todayOnly: Boolean(payload?.todayOnly) })
  )
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.eris.ide')
  }

  const icon = resolveAppIcon()
  if (icon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  try {
    stripLegacySubagentsFromUserSettings()
  } catch {
    // ignore migrate errors
  }

  try {
    configureLogger(getResolvedSettings(null))
    logInfo('Eris started', { version: app.getVersion(), packaged: app.isPackaged })
  } catch (err) {
    // logger may still work with defaults
    logWarn('Logger configure failed at launch', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  registerIpc()
  buildMenu()
  createWindow()

  // Warm login-shell PATH off the critical path (Dock launches omit Homebrew/nvm).
  setImmediate(() => {
    try {
      resolveLoginShellPath()
    } catch {
      // ignore
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  chatAbort?.abort()
  chatAbort = null
  setDiagnosticsPaused(false)
  stopWorkspaceWatcher()
  disposePtySession()
  void disposeTsLsp().catch(() => undefined)
  void disposeMcpRuntime().catch(() => undefined)
  void disposeRuntime()
    .catch(() => undefined)
    .finally(() => {
      app.exit(0)
    })
})
