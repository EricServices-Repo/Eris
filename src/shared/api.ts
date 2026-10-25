import type { LocalImageStatus, LocalImageProgress } from './image-generation'
import type {
  GeneratedImageAsset,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProgress
} from './image-generation'
import type {
  AppSettings,
  ChatDelegation,
  ChatThread,
  ChatMessage,
  FileEntry,
  BuiltinModelStatus,
  GpuAccelStatus,
  HfGgufSearchHit,
  LocalModelStatus,
  ModelsStatus,
  ProjectAgentsConfig,
  ResolvedAgent,
  RouteResult,
  TurnPlan,
  ChatIntent,
  ChatPromptInput,
  SettingsPatch,
  SettingsScope,
  SkillInput,
  SkillRecord,
  SkillScope,
  WorkspaceMeta,
  WorkspaceRecord
} from './settings-schema'
import type {
  CorpusDebugProgressEvent,
  CorpusDebugRunRequest,
  CorpusDebugRunSummary,
  EvalProgressEvent,
  EvalResult,
  EvalScoreboard,
  EvalTaskInfo,
  RejectedEvalTask
} from './evals'
import type {
  DebugExportPreview,
  DebugExportRequest,
  DebugReplayRequest,
  DebugRunDetail,
  DebugRunProgressEvent,
  DebugRunRequest,
  DebugRunSummary,
  DebugScenarioInfo
} from './debug-runs'
import type {
  BackgroundJob,
  BackgroundJobEvent,
  EnqueueBackgroundJobRequest
} from './background-agents'
import type { AgentOutcomeSummary } from './agent-telemetry'
import type { OllamaLibraryEntry, OllamaPullProgress } from './ollama-types'
import type { ChatJobSnapshot } from './chat-jobs'

export interface AppState {
  workspaces: WorkspaceRecord[]
  lastWorkspaceId: string | null
  /** ISO or epoch ms when the first-run setup wizard was finished/skipped */
  onboardingCompletedAt?: number | null
}

export interface WorkspaceTrustStatus {
  workspacePath: string | null
  trusted: boolean
  /** Human-readable risky settings this folder's .eris/settings.json asks for */
  risky: string[]
}

export interface AgentSessionStepSummary {
  step: number
  opThrough: number
  summary: string
  ts: string
  filesTouched: string[]
}

export interface AppVersionInfo {
  version: string
  name: string
  packaged: boolean
}

export interface LayeredSettings {
  defaults: AppSettings
  user: SettingsPatch
  workspace: SettingsPatch
  resolved: AppSettings
}

export type UsageLimitMeter = {
  used: number
  limit: number | null
  remaining: number | null
  ratio: number
  exhausted: boolean
}

export type UsageEntitlement = {
  plan: 'free' | 'pro'
  planLabel: string
  authenticated: boolean
  limits: {
    dailyRequests: number | null
    dailyTokens: number | null
    cloudJobsPerDay: number | null
  }
  requests: UsageLimitMeter
  tokens: UsageLimitMeter
  cloudJobs: UsageLimitMeter
  overLimit: boolean
  blockedReason: string | null
  upgradeUrl: string
  accountUrl: string
  /** True when the rolling window includes a pull from www.ericservic.es profile usage. */
  profileSynced?: boolean
  window?: { from: string; to: string; days: number }
}

export type UsageDayTotals = {
  requests: number
  inputTokens: number
  outputTokens: number
  cloudJobs: number
}

export type UsageSyncMeta = {
  state: 'idle' | 'syncing' | 'ok' | 'offline' | 'error'
  lastSyncedAt: string | null
  lastError: string | null
  authenticated: boolean
}

export type UsageSnapshot = {
  today: {
    date: string
    models: Record<
      string,
      {
        model: string
        kind: 'builtin' | 'openai-compatible' | 'other'
        provider: string
        requests: number
        inputTokens: number
        outputTokens: number
      }
    >
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    cloudJobs?: number
  }
  /** Rolling 30-day totals used for plan limits (max of device and profile per day). */
  window?: UsageDayTotals & { from: string; to: string; days: number }
  /** Account vs device breakdown when signed in */
  profile?: {
    sync: UsageSyncMeta
    deviceToday: UsageDayTotals
    accountToday: UsageDayTotals | null
    effectiveToday: UsageDayTotals
    deviceWindow?: UsageDayTotals
    accountWindow?: UsageDayTotals | null
    effectiveWindow?: UsageDayTotals
  }
  days: Array<{
    date: string
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    cloudJobs?: number
    models?: Record<
      string,
      {
        model: string
        kind: 'builtin' | 'openai-compatible' | 'other'
        provider: string
        requests: number
        inputTokens: number
        outputTokens: number
      }
    >
  }>
  byKind: Array<{
    kind: 'builtin' | 'openai-compatible' | 'other'
    label: string
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  byModel: Array<{
    model: string
    kind: 'builtin' | 'openai-compatible' | 'other'
    provider: string
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    share: number
  }>
  entitlement?: UsageEntitlement
}

export interface IdeApi {
  localImageStatus: () => Promise<LocalImageStatus>
  setupLocalImageRuntime: () => Promise<{ ok: boolean; status?: LocalImageStatus; error?: string }>
  downloadLocalImageModel: (
    repoId: string
  ) => Promise<{ ok: boolean; status?: LocalImageStatus; error?: string }>
  deleteLocalImageModel: (
    id: string
  ) => Promise<{ ok: boolean; status?: LocalImageStatus; error?: string }>
  cancelLocalImageOperation: () => Promise<boolean>
  onLocalImageProgress: (cb: (progress: LocalImageProgress) => void) => () => void
  generateImage: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>
  cancelImageGeneration: (requestId: string) => Promise<boolean>
  saveImageToWorkspace: (id: string, path: string) => Promise<{ ok: boolean; error?: string }>
  onImageProgress: (cb: (progress: ImageGenerationProgress) => void) => () => void
  onChatAsset: (cb: (data: { requestId: string; asset: GeneratedImageAsset }) => void) => () => void
  getAppState: () => Promise<AppState>
  getAppVersion: () => Promise<AppVersionInfo>
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
  completeOnboarding: () => Promise<AppState>
  resetOnboarding: () => Promise<AppState>
  listWorkspaces: () => Promise<WorkspaceRecord[]>
  createWorkspace: (name: string) => Promise<WorkspaceRecord | null>
  linkWorkspace: (name?: string) => Promise<WorkspaceRecord | null>
  openWorkspace: () => Promise<string | null>
  openWorkspacePath: (path: string) => Promise<string | null>
  openWorkspaceById: (id: string) => Promise<WorkspaceRecord | null>
  renameWorkspace: (id: string, name: string) => Promise<WorkspaceRecord | null>
  removeWorkspace: (id: string) => Promise<AppState>
  getCurrentWorkspace: () => Promise<string | null>
  setCurrentWorkspace: (path: string | null) => Promise<string | null>
  getWorkspaceMeta: (path: string) => Promise<WorkspaceMeta>
  setWorkspaceMeta: (path: string, meta: WorkspaceMeta) => Promise<WorkspaceMeta>
  getLayeredSettings: () => Promise<LayeredSettings>
  getResolvedSettings: () => Promise<AppSettings>
  setSettings: (scope: SettingsScope, patch: SettingsPatch) => Promise<AppSettings>
  resetSettingKey: (scope: SettingsScope, pathKeys: string[]) => Promise<AppSettings>
  getCredentialStatus: () => Promise<{
    policy: 'local' | 'vault'
    legacyPending: boolean
    plaintextRemaining: boolean
  }>
  setCredentialPolicy: (
    policy: 'local' | 'vault'
  ) => Promise<{ policy: 'local' | 'vault'; legacyPending: boolean; plaintextRemaining: boolean }>
  setSecret: (key: string, value: string) => Promise<boolean>
  hasSecret: (key: string) => Promise<boolean>
  listTree: (root: string, maxDepth?: number) => Promise<FileEntry[]>
  readFile: (
    path: string
  ) => Promise<{ path: string; content: string; name: string; language: string }>
  writeFile: (path: string, content: string) => Promise<boolean>
  pickFiles: () => Promise<string[]>
  /** Light by default (no connection probes). Pass `{ probe: true }` from Settings → Providers. */
  modelsStatus: (opts?: { probe?: boolean; includeGpu?: boolean }) => Promise<ModelsStatus>
  /** Background-load a selected or default ready GGUF into the llama worker. */
  warmLocalModel: (modelRef?: string) => Promise<{ ok: boolean; model?: string; error?: string }>
  builtinModelStatus: () => Promise<BuiltinModelStatus[]>
  downloadBuiltinModel: (id?: string) => Promise<BuiltinModelStatus>
  deleteBuiltinModel: (id?: string) => Promise<boolean>
  verifyBuiltinModel: (id?: string) => Promise<{
    ok: boolean
    digest?: string
    expected?: string | null
    error?: string
  }>
  cancelBuiltinDownload: () => Promise<boolean>
  /** Local GGUFs that run inside Eris (no Ollama). */
  localModelStatus: () => Promise<LocalModelStatus[]>
  downloadLocalModel: (id: string) => Promise<LocalModelStatus>
  deleteLocalModel: (id: string) => Promise<LocalModelStatus | null>
  cancelLocalDownload: () => Promise<boolean>
  onLocalDownloadProgress: (cb: (status: LocalModelStatus) => void) => () => void
  /** Hugging Face Hub — browse / search / download GGUFs into Text Models. */
  hfGgufBrowseUrl: () => Promise<string>
  searchHfGgufModels: (query: string) => Promise<HfGgufSearchHit[]>
  downloadLocalModelFromHf: (repoIdOrUrl: string) => Promise<LocalModelStatus>
  gpuAccelStatus: () => Promise<GpuAccelStatus>
  reloadLlamaGpu: () => Promise<GpuAccelStatus>
  /** #10 opt-in telemetry: record the user's Keep/Undo decisions for the last run. */
  recordDiffDecision: (payload: { kept?: number; undone?: number }) => Promise<boolean>
  getAgentTelemetry: () => Promise<AgentOutcomeSummary[]>
  /** Optional external Ollama daemon (advanced). Prefer downloadLocalModel. */
  ollamaLibrary: () => Promise<OllamaLibraryEntry[]>
  ollamaInstalled: () => Promise<{ ok: boolean; models: string[]; error?: string }>
  ollamaPull: (name: string) => Promise<{ ok: boolean; model?: string; error?: string }>
  ollamaDelete: (name: string) => Promise<{ ok: boolean; error?: string }>
  onOllamaPullProgress: (cb: (p: OllamaPullProgress) => void) => () => void
  onBuiltinDownloadProgress: (cb: (status: BuiltinModelStatus) => void) => () => void
  listAgents: () => Promise<ResolvedAgent[]>
  getProjectAgents: () => Promise<ProjectAgentsConfig>
  saveProjectAgents: (config: ProjectAgentsConfig) => Promise<ProjectAgentsConfig>
  resetProjectAgents: () => Promise<ProjectAgentsConfig>
  routeAgent: (payload: {
    text: string
    fileNames: string[]
    manualAgentId?: string | null
  }) => Promise<RouteResult>
  planChatTurn: (payload: {
    text: string
    fileNames?: string[]
    manualAgentId?: string | null
    selectedModel: string
    mode?: 'ask' | 'agent'
    forceRoute?: 'tools' | 'answer'
    previousAgentId?: string | null
    previousMessages?: Array<{ role: 'user' | 'assistant'; content: string; agentId?: string }>
  }) => Promise<TurnPlan>
  recordRoutingFeedback: (payload: {
    text: string
    from: ChatIntent
    to: 'tools' | 'answer'
    agentId: string
  }) => Promise<boolean>
  listSessionSteps: (sessionId: string) => Promise<AgentSessionStepSummary[]>
  getAgentSession: (sessionId: string) => Promise<{
    id: string
    goal: string
    status: string
    step: number
    checkpointId: string | null
  } | null>
  getWorkspaceTrust: () => Promise<WorkspaceTrustStatus>
  setWorkspaceTrust: (trusted: boolean) => Promise<boolean>
  listChats: () => Promise<ChatThread[]>
  getChat: (id: string, page?: { before?: number; limit?: number }) => Promise<ChatThread | null>
  appendChatMessage: (
    id: string,
    message: ChatMessage,
    model?: string,
    workspacePath?: string | null
  ) => Promise<ChatThread>
  createChat: (model: string) => Promise<ChatThread>
  saveChat: (thread: ChatThread) => Promise<ChatThread>
  deleteChat: (id: string) => Promise<boolean>
  loadRules: () => Promise<string>
  listSkills: () => Promise<SkillRecord[]>
  getSkill: (id: string, scope?: SkillScope) => Promise<SkillRecord | null>
  createSkill: (input: SkillInput) => Promise<SkillRecord>
  updateSkill: (
    id: string,
    scope: SkillScope,
    patch: Partial<Pick<SkillInput, 'name' | 'description' | 'body'>>
  ) => Promise<SkillRecord>
  deleteSkill: (id: string, scope: SkillScope) => Promise<boolean>
  loadSkillsPrompt: (ids: string[]) => Promise<string>
  streamChat: (payload: {
    requestId: string
    model: string
    messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    prompt?: ChatPromptInput
    agentId?: string
    mode?: 'ask' | 'agent'
    workspacePath?: string | null
    forceRoute?: 'tools' | 'answer'
    turnPlan?: TurnPlan
    threadId?: string | null
    planningDurationMs?: number
  }) => Promise<boolean>
  getLatestChatJob: (threadId?: string | null) => Promise<ChatJobSnapshot | null>
  stopChat: (requestId?: string) => Promise<boolean>
  /** Absolute path of a dropped File ('' when it has none) */
  getPathForFile: (file: File) => string
  respondCommandApproval: (
    approvalId: string,
    decision: 'allow' | 'always' | 'deny'
  ) => Promise<boolean>
  onChatApprovalRequest: (
    cb: (data: {
      requestId: string
      approvalId: string
      kind: 'run' | 'push' | 'mcp'
      command: string
      toolName?: string
      canAlwaysAllow?: boolean
    }) => void
  ) => () => void
  onChatApprovalResolved: (
    cb: (data: {
      requestId: string
      approvalId: string
      decision: 'allow' | 'always' | 'deny'
    }) => void
  ) => () => void
  respondUserQuestion: (questionId: string, reply: string | null) => Promise<boolean>
  onChatQuestionRequest: (
    cb: (data: {
      requestId: string
      questionId: string
      question: string
      choices?: string[]
      timeoutMs: number
    }) => void
  ) => () => void
  onChatQuestionResolved: (
    cb: (data: {
      requestId: string
      questionId: string
      timedOut?: boolean
      dismissed?: boolean
      reply?: string
    }) => void
  ) => () => void
  onChatThinking: (cb: (data: { requestId: string; chunk: string }) => void) => () => void
  onChatAnswer: (
    cb: (data: { requestId: string; chunk: string; replace?: boolean }) => void
  ) => () => void
  onChatDone: (cb: (data: { requestId: string; aborted?: boolean }) => void) => () => void
  onChatError: (cb: (data: { requestId: string; error: string }) => void) => () => void
  onChatDelegation: (
    cb: (data: { requestId: string; delegation: ChatDelegation }) => void
  ) => () => void
  onChatTool: (
    cb: (data: {
      requestId: string
      tool: {
        id: string
        name: string
        path?: string
        status: 'running' | 'ok' | 'error'
        effect?: 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
        changedResources?: string[]
        durationMs?: number
        failure?: { code: string; retryable: boolean; cause?: string }
        detail: string
      }
    }) => void
  ) => () => void
  onChatDiff: (
    cb: (data: {
      requestId: string
      diff: {
        checkpointId: string
        opIndex: number
        path: string
        before: string | null
        after: string
        op: 'write' | 'delete' | 'rename' | 'mkdir' | 'binary'
      }
    }) => void
  ) => () => void
  onChatCheckpoint: (cb: (data: { requestId: string; checkpointId: string }) => void) => () => void
  onChatSession: (
    cb: (data: { requestId: string; sessionId: string; checkpointId: string }) => void
  ) => () => void
  onChatSessionStep: (
    cb: (data: {
      requestId: string
      sessionId: string
      step: number
      summary: string
      opThrough: number
      filesTouched: string[]
    }) => void
  ) => () => void
  onChatTerminal: (cb: (data: { requestId: string; text: string }) => void) => () => void
  onChatWorkspaceChanged: (cb: (data: { requestId: string }) => void) => () => void
  onChatStatus: (cb: (data: { requestId: string; text: string }) => void) => () => void
  onChatModel: (
    cb: (data: { requestId: string; model: string; agentId?: string; agentName?: string }) => void
  ) => () => void
  onChatRouted: (
    cb: (data: {
      requestId: string
      agentId?: string
      agentName?: string
      model: string
      reason?: string
      intent?: string
      task?: import('./task-contract').TaskContract
      toolsModel?: string
    }) => void
  ) => () => void
  restoreCheckpoint: (checkpointId: string) => Promise<{ restored: number }>
  restoreCheckpointOp: (
    checkpointId: string,
    opIndex: number
  ) => Promise<{ restored: number; path?: string }>
  runCommand: (command: string) => Promise<{
    ok: boolean
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    command: string
  }>
  onTerminalData: (
    cb: (payload: { chunk: string; stream: 'stdout' | 'stderr' }) => void
  ) => () => void
  ptyEnsure: (size?: { cols?: number; rows?: number }) => Promise<{ ok: boolean; error?: string }>
  ptyWrite: (data: string) => Promise<{ ok: boolean; error?: string }>
  ptyResize: (size: { cols: number; rows: number }) => Promise<{ ok: boolean; error?: string }>
  ptyKill: () => Promise<{ ok: boolean }>
  onPtyData: (cb: (data: string) => void) => () => void
  onPtyExit: (cb: (payload: { exitCode: number; signal?: number }) => void) => () => void
  gitStatus: () => Promise<{
    ok: boolean
    error?: string
    branch: string | null
    ahead: number
    behind: number
    entries: Array<{ path: string; index: string; worktree: string; status: string }>
  }>
  gitDiff: (path?: string) => Promise<{ ok: boolean; diff: string; error?: string }>
  gitStage: (paths: string[]) => Promise<{ ok: boolean; error?: string }>
  gitCommitReviewed: (input: {
    root: string
    branch: string
    head: string
    message: string
    action?: 'stage' | 'commit'
    changes: { checkpointId: string; opIndex: number }[]
  }) => Promise<{ ok: boolean; error?: string; root?: string; branch?: string; commit?: string }>
  gitHead: () => Promise<string>
  gitCommit: (message: string) => Promise<{ ok: boolean; error?: string }>
  gitBranches: () => Promise<{
    ok: boolean
    current: string | null
    branches: string[]
    error?: string
  }>
  gitCheckout: (payload: {
    branch: string
    create?: boolean
  }) => Promise<{ ok: boolean; error?: string }>
  gitStash: (payload?: {
    action?: 'push' | 'pop' | 'list'
    message?: string
  }) => Promise<{ ok: boolean; output?: string; error?: string }>
  githubStatus: () => Promise<{
    ok: boolean
    error?: string
    linked: boolean
    host: string
    repository: string
    remoteName: string
    defaultBranch: string
    preferredProtocol: 'https' | 'ssh'
    hasToken: boolean
    remoteUrl: string | null
    pageUrl: string | null
    cloneUrlHttps: string | null
    cloneUrlSsh: string | null
    isGitRepo: boolean
    branch: string | null
    ahead: number
    behind: number
    apiUser?: string | null
  }>
  githubTestToken: (token?: string) => Promise<{ ok: boolean; login?: string; error?: string }>
  githubSetToken: (
    token: string
  ) => Promise<{ ok: boolean; login?: string; error?: string; cleared?: boolean }>
  githubLink: (payload: {
    repository: string
    remoteName?: string
    defaultBranch?: string
    preferredProtocol?: 'https' | 'ssh'
    host?: string
    setGitRemote?: boolean
  }) => Promise<Record<string, unknown>>
  githubUnlink: () => Promise<Record<string, unknown>>
  githubDetectRemote: () => Promise<{
    ok: boolean
    error?: string
    repository?: string
    host?: string
    pageUrl?: string
  }>
  githubOpen: (
    which?: 'page' | 'issues' | 'prs' | 'actions'
  ) => Promise<{ ok: boolean; url?: string; error?: string }>
  githubSync: (
    action: 'fetch' | 'pull' | 'push'
  ) => Promise<{ ok: boolean; output?: string; error?: string }>
  githubCreateRepo: (payload: {
    name: string
    description?: string
    privateRepo?: boolean
    autoInit?: boolean
    link?: boolean
  }) => Promise<{
    ok: boolean
    fullName?: string
    htmlUrl?: string
    cloneUrl?: string
    error?: string
    link?: Record<string, unknown>
  }>
  githubListPullRequests: () => Promise<{
    ok: boolean
    error?: string
    pullRequests: Array<{
      number: number
      title: string
      htmlUrl: string
      state: string
      head: string
      base: string
    }>
  }>
  githubCreatePullRequest: (payload: {
    title: string
    body?: string
    head?: string
    base?: string
    draft?: boolean
  }) => Promise<{ ok: boolean; error?: string; number?: number; htmlUrl?: string }>
  onWorkspaceFsChanged: (
    cb: (payload: { workspacePath: string; path: string; paths?: string[] }) => void
  ) => () => void
  ericServicesStatus: (opts?: { cached?: boolean }) => Promise<{
    ok: boolean
    error?: string
    linked: boolean
    hasToken: boolean
    needsReauth?: boolean
    apiBase: string
    username: string
    email: string
    lastSyncedAt: string
    syncEnabled: boolean
    plan?: 'free' | 'pro' | string
    profile?: {
      username: string
      email: string
      isAdmin?: boolean
      accountUrl?: string
      plan?: string
      planLabel?: string
      erisPlan?: string
      features?: Record<string, unknown>
      erisLimits?: Record<string, unknown>
    } | null
    remoteUpdatedAt?: string | null
  }>
  ericServicesLogin: (payload: {
    username: string
    password: string
    apiBase?: string
    syncAfter?: boolean
  }) => Promise<{
    ok: boolean
    error?: string
    profile?: {
      username: string
      email: string
      isAdmin?: boolean
      accountUrl?: string
      plan?: string
      planLabel?: string
      erisPlan?: string
      features?: Record<string, unknown>
      erisLimits?: Record<string, unknown>
    }
    status?: Record<string, unknown>
    sync?: {
      ok: boolean
      error?: string
      direction?: string
      changes?: string[]
      missingKeys?: Array<{ id: string; name: string }>
    }
  }>
  ericServicesLoginBrowser: (payload?: { apiBase?: string }) => Promise<{
    ok: boolean
    error?: string
    userCode?: string
    profile?: {
      username: string
      email: string
      plan?: string
      planLabel?: string
      erisPlan?: string
    }
    sync?: {
      ok: boolean
      error?: string
      direction?: string
      changes?: string[]
      missingKeys?: Array<{ id: string; name: string }>
    }
  }>
  ericServicesDevices: () => Promise<{
    ok: boolean
    error?: string
    devices?: Array<{
      id: number
      name: string
      prefix: string
      lastUsedAt: string | null
      createdAt: string | null
      current: boolean
    }>
  }>
  ericServicesRevokeDevice: (id: number) => Promise<{
    ok: boolean
    error?: string
    revokedCurrent?: boolean
  }>
  ericServicesLogout: () => Promise<{
    ok: boolean
    linked: boolean
    hasToken: boolean
    apiBase: string
    username: string
    email: string
    lastSyncedAt: string
    syncEnabled: boolean
  }>
  ericServicesSync: (direction?: 'pull' | 'push' | 'bidirectional') => Promise<{
    ok: boolean
    error?: string
    direction?: string
    updatedAt?: string | null
    changes?: string[]
    missingKeys?: Array<{ id: string; name: string }>
    status?: Record<string, unknown>
  }>
  ericServicesOpenAccount: () => Promise<{ ok: boolean; url?: string; error?: string }>
  ericServicesOpenUpgrade: () => Promise<{ ok: boolean; url?: string; error?: string }>
  mcpStatus: () => Promise<{
    servers: Array<{
      id: string
      name: string
      transport: 'stdio' | 'sse' | 'http'
      connected: boolean
      toolCount: number
      error?: string
    }>
    tools: Array<{
      serverId: string
      serverName: string
      name: string
      description: string
      fqName: string
    }>
  }>
  mcpReconnect: () => Promise<{
    servers: Array<{
      id: string
      name: string
      transport: 'stdio' | 'sse' | 'http'
      connected: boolean
      toolCount: number
      error?: string
    }>
    tools: Array<{
      serverId: string
      serverName: string
      name: string
      description: string
      fqName: string
    }>
  }>
  searchGrep: (
    pattern: string,
    glob?: string
  ) => Promise<{
    ok: boolean
    detail: string
    hits: Array<{ path: string; line: number; text: string }>
  }>
  searchGlob: (pattern: string) => Promise<{ ok: boolean; detail: string; paths: string[] }>
  searchSymbols: (query: string) => Promise<{
    ok: boolean
    detail: string
    hits: Array<{ name: string; kind: string; path: string; line: number }>
  }>
  searchRetrieve: (query: string) => Promise<{ ok: boolean; detail: string; paths: string[] }>
  rebuildCodeIndex: () => Promise<{ ok: boolean; files: number; symbols: number }>
  codeIndexStats: () => Promise<{
    ok: boolean
    files: number
    symbols: number
    refs: number
    summary: string
    topSymbols: Array<{ name: string; kind: string; path: string; line: number }>
    rules: number
    skills: number
  }>
  getCloudJob: (id: string) => Promise<BackgroundJob | null>
  searchReferences: (name: string) => Promise<{
    ok: boolean
    detail: string
    hits: Array<{ name: string; path: string; line: number }>
  }>
  searchRelated: (path: string) => Promise<{ ok: boolean; detail: string; paths: string[] }>
  listEvalTasks: () => Promise<EvalTaskInfo[]>
  getEvalScoreboard: () => Promise<EvalScoreboard>
  runEvals: (payload: {
    taskIds: string[]
    models: string[]
    repeats?: number
  }) => Promise<EvalResult[]>
  cancelEvals: () => Promise<boolean>
  evalsRunning: () => Promise<boolean>
  clearEvalResults: () => Promise<EvalScoreboard>
  onEvalProgress: (cb: (event: EvalProgressEvent) => void) => () => void
  listCorpusDebugRuns: () => Promise<CorpusDebugRunSummary[]>
  runCorpusDebug: (payload: CorpusDebugRunRequest) => Promise<CorpusDebugRunSummary>
  cancelCorpusDebug: () => Promise<boolean>
  corpusDebugRunning: () => Promise<boolean>
  exportCorpusDebug: (runId: string) => Promise<string | null>
  openCorpusDebugFolder: () => Promise<boolean>
  onCorpusDebugProgress: (cb: (event: CorpusDebugProgressEvent) => void) => () => void
  listRejectedEvalTasks: () => Promise<RejectedEvalTask[]>
  listDebugScenarios: () => Promise<DebugScenarioInfo[]>
  listDebugRuns: () => Promise<DebugRunSummary[]>
  getDebugRun: (runId: string) => Promise<DebugRunDetail>
  debugRunActive: () => Promise<boolean>
  startDebugRun: (request: DebugRunRequest) => Promise<DebugRunSummary>
  replayDebugRun: (request: DebugReplayRequest) => Promise<DebugRunSummary>
  cancelDebugRun: () => Promise<boolean>
  previewDebugRunExport: (request: DebugExportRequest) => Promise<DebugExportPreview>
  exportDebugRun: (
    request: DebugExportRequest
  ) => Promise<{ jsonPath: string; markdownPath: string } | null>
  deleteDebugRun: (runId: string) => Promise<boolean>
  deleteAllDebugRuns: () => Promise<number>
  onDebugRunEvent: (cb: (event: DebugRunProgressEvent) => void) => () => void
  listBackgroundJobs: () => Promise<BackgroundJob[]>
  enqueueBackgroundJob: (payload: EnqueueBackgroundJobRequest) => Promise<BackgroundJob>
  stopBackgroundJob: (id: string) => Promise<boolean>
  discardBackgroundJob: (id: string) => Promise<BackgroundJob>
  mergeBackgroundJob: (id: string) => Promise<BackgroundJob>
  backgroundJobDiff: (id: string) => Promise<{ ok: boolean; diff: string; error?: string }>
  bringJobIntoChat: (
    id: string,
    threadId?: string | null
  ) => Promise<{ ok: boolean; threadId: string; content: string; error?: string }>
  onBackgroundJob: (cb: (event: BackgroundJobEvent) => void) => () => void
  /** Always https://agents.ericservic.es:443 — not user-configurable */
  cloudAgentsBaseUrl: () => Promise<string>
  cloudAgentsHealth: () => Promise<import('./cloud-agents').CloudHealth>
  listCloudJobs: () => Promise<BackgroundJob[]>
  enqueueCloudJob: (
    payload: import('./cloud-agents').EnqueueCloudJobRequest
  ) => Promise<BackgroundJob>
  continueCloudJob: (
    id: string,
    payload?: Partial<import('./cloud-agents').EnqueueCloudJobRequest>
  ) => Promise<BackgroundJob>
  stopCloudJob: (id: string) => Promise<boolean>
  /** Stop all queued/running Cloud jobs for the signed-in account */
  stopAllCloudJobs: () => Promise<{ count: number; stopped: string[] }>
  cloudJobArtifacts: (id: string) => Promise<import('./cloud-agents').CloudJobArtifacts>
  applyCloudJobArtifacts: (id: string) => Promise<{
    ok: boolean
    checkpointId: string
    truncated: boolean
    error?: string
    diffs: Array<{
      id: string
      checkpointId: string
      opIndex: number
      path: string
      before: string | null
      after: string
      op: 'write'
      status: 'pending'
    }>
  }>
  aiComplete: (payload: {
    path: string
    language: string
    prefix: string
    suffix: string
    requestId?: string
  }) => Promise<{ ok: boolean; text?: string; error?: string; requestId?: string }>
  aiCompleteCancel: (requestId?: string) => Promise<{ ok: boolean }>
  aiInlineEdit: (payload: {
    path: string
    language: string
    selection: string
    instruction: string
    before?: string
    after?: string
  }) => Promise<{ ok: boolean; text?: string; error?: string }>
  getDiagnostics: () => Promise<{
    ok: boolean
    diagnostics: Array<{
      path: string
      line: number
      column: number
      endLine?: number
      endColumn?: number
      severity: 'error' | 'warning' | 'info'
      message: string
      source: string
    }>
    detail: string
  }>
  languageHover: (filePath: string, word: string) => Promise<{ ok: boolean; contents: string }>
  goToDefinition: (word: string) => Promise<{
    ok: boolean
    locations: Array<{ path: string; line: number; name: string; kind: string }>
  }>
  lspDidOpen: (payload: {
    path: string
    language: string
    text: string
  }) => Promise<{ ok: boolean }>
  lspDidChange: (payload: {
    path: string
    language: string
    text: string
  }) => Promise<{ ok: boolean }>
  lspDidClose: (path: string) => Promise<{ ok: boolean }>
  lspHover: (payload: {
    path: string
    line: number
    character: number
  }) => Promise<{ ok: boolean; contents: string }>
  lspDefinition: (payload: { path: string; line: number; character: number }) => Promise<{
    ok: boolean
    locations: Array<{ path: string; line: number; name: string; kind: string }>
  }>
  lspCompletion: (payload: { path: string; line: number; character: number }) => Promise<{
    ok: boolean
    items: Array<{ label: string; detail?: string; insertText?: string }>
  }>
  onLspDiagnostics: (
    cb: (payload: {
      path: string
      diagnostics: Array<{
        path: string
        line: number
        column: number
        endLine?: number
        endColumn?: number
        severity: 'error' | 'warning' | 'info'
        message: string
        source: string
      }>
    }) => void
  ) => () => void
  runVerify: () => Promise<{
    ok: boolean
    command: string
    detail: string
    skipped?: boolean
  }>
  debugListConfigs: () => Promise<
    Array<{
      id: string
      name: string
      type: 'node'
      request: 'launch'
      program: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      runtimeArgs?: string[]
    }>
  >
  debugSaveConfigs: (
    configs: Array<{
      id: string
      name: string
      type: 'node'
      request: 'launch'
      program: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      runtimeArgs?: string[]
    }>
  ) => Promise<
    Array<{
      id: string
      name: string
      type: 'node'
      request: 'launch'
      program: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      runtimeArgs?: string[]
    }>
  >
  debugListBreakpoints: () => Promise<
    Array<{ id: string; path: string; line: number; enabled: boolean }>
  >
  debugSaveBreakpoints: (
    bps: Array<{ id: string; path: string; line: number; enabled: boolean }>
  ) => Promise<Array<{ id: string; path: string; line: number; enabled: boolean }>>
  debugState: () => Promise<{
    running: boolean
    paused: boolean
    configId: string | null
    program: string | null
    port: number | null
    output: string
    reason?: string
    callFrames?: Array<{ functionName: string; url: string; lineNumber: number }>
  }>
  debugStart: (
    configId: string,
    activeFile?: string | null
  ) => Promise<{
    running: boolean
    paused: boolean
    configId: string | null
    program: string | null
    port: number | null
    output: string
  }>
  debugStop: () => Promise<{
    running: boolean
    paused: boolean
    configId: string | null
    program: string | null
    port: number | null
    output: string
  }>
  debugContinue: () => Promise<void>
  debugStepOver: () => Promise<void>
  debugStepInto: () => Promise<void>
  debugStepOut: () => Promise<void>
  onDebugState: (
    cb: (state: {
      running: boolean
      paused: boolean
      configId: string | null
      program: string | null
      port: number | null
      output: string
      reason?: string
      callFrames?: Array<{ functionName: string; url: string; lineNumber: number }>
    }) => void
  ) => () => void
  listRules: () => Promise<Array<{ id: string; name: string; body: string }>>
  saveRule: (
    name: string,
    body: string,
    previousId?: string
  ) => Promise<{ id: string; name: string; body: string }>
  deleteRule: (id: string) => Promise<boolean>
  getWorkspaceContext: () => Promise<{
    body: string
    pin: string
    updatedAt: number
    empty: boolean
  }>
  /** Short pinned summary for chat system prompt (empty if none). */
  loadWorkspaceContextPin: () => Promise<string>
  saveWorkspaceContext: (body: string) => Promise<{
    body: string
    pin: string
    updatedAt: number
    empty: boolean
  }>
  setWorkspaceContextSummary: (summary: string) => Promise<{
    body: string
    pin: string
    updatedAt: number
    empty: boolean
  }>
  appendWorkspaceContextNote: (note: string) => Promise<{
    body: string
    pin: string
    updatedAt: number
    empty: boolean
  }>
  resetWorkspaceContext: () => Promise<{
    body: string
    pin: string
    updatedAt: number
    empty: boolean
  }>
  canUndoProjectMemory: () => Promise<boolean>
  undoProjectMemory: () => Promise<{
    ok: boolean
    body: string
    pin: string
    updatedAt: number
    empty: boolean
  }>
  confirmProjectMemory: (proposal: {
    note?: string
    summary?: string
  }) => Promise<{ wrote: boolean; kind?: string; preview: string }>
  onChatMemoryUpdated: (
    cb: (data: { requestId: string; kind?: string; preview: string }) => void
  ) => () => void
  onChatMemoryProposal: (
    cb: (data: { requestId: string; note?: string; summary?: string; preview: string }) => void
  ) => () => void
  getUsageStats: (days?: number, opts?: { refresh?: boolean }) => Promise<UsageSnapshot>
  clearUsageStats: (payload?: { todayOnly?: boolean }) => Promise<UsageSnapshot>
  onMenu: (channel: string, cb: () => void) => () => void
  getLogsInfo: () => Promise<{
    enabled: boolean
    level: 'debug' | 'info' | 'warn' | 'error'
    directory: string
    defaultDirectory: string
    currentFile: string
    files: Array<{ name: string; path: string; size: number; mtime: number }>
  }>
  readLogs: (fileName?: string) => Promise<{ path: string; content: string; truncated: boolean }>
  clearLogs: () => Promise<{ cleared: number }>
  openLogsFolder: () => Promise<string>
  pickLogsDirectory: () => Promise<string | null>
  writeLog: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: unknown
  ) => Promise<boolean>
  getUpdateStatus: () => Promise<UpdateStatusSnapshot>
  checkForAppUpdates: (silent?: boolean) => Promise<UpdateStatusSnapshot>
  downloadAppUpdate: () => Promise<UpdateStatusSnapshot>
  installAppUpdate: () => Promise<{ ok: boolean }>
  openAppReleasesPage: () => Promise<void>
  dismissAppUpdate: () => Promise<{ ok: boolean }>
  onUpdateStatus: (cb: (status: UpdateStatusSnapshot) => void) => () => void
  previewBugReport: (input: BugReportInput) => Promise<BugReportPreview>
  submitBugReport: (input: BugReportInput) => Promise<BugReportResult>
  listFeedbackHistory: () => Promise<FeedbackHistoryItem[]>
}

export interface FeedbackHistoryItem {
  id: string
  title: string
  number?: number
  htmlUrl?: string
  via?: 'ericservices' | 'builtin'
  submittedAt: string
}

export interface BugReportInput {
  title: string
  description: string
  includeLogs?: boolean
  includeDiagnostics?: boolean
}

export interface BugReportDiagnostics {
  appName: string
  appVersion: string
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  release: string
  arch: string
  locale: string
  cpuCount: number
  totalMemGb: number
  workspaceLinked: boolean
  workspaceName: string | null
  defaultModel: string | null
  ericServicesLinked: boolean
  ericServicesPlan: string | null
  githubHost: string | null
  githubLinked: boolean
  loggingEnabled: boolean
  loggingLevel: string
  logDirectory: string
  currentLogFile: string
  logFileCount: number
}

export interface BugReportPreview {
  title: string
  body: string
  diagnostics: BugReportDiagnostics
  logIncluded: boolean
  logTruncated: boolean
  logPath: string | null
  hasGithubToken: boolean
  targetRepo: string
}

export interface BugReportResult {
  ok: boolean
  error?: string
  number?: number
  htmlUrl?: string
  via?: 'ericservices' | 'builtin'
}

export type UpdateState =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatusSnapshot {
  state: UpdateState
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseNotes?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
  canOpenReleases: boolean
  autoCheck: boolean
  autoDownload: boolean
  packaged: boolean
  lastCheckedAt?: string
  /** Unsigned macOS build — open Releases instead of in-place Squirrel install */
  manualInstallOnly?: boolean
}
