import { z } from 'zod'

export const AgentToolsCeilingSchema = z.enum(['none', 'read', 'edit', 'full'])
export type AgentToolsCeiling = z.infer<typeof AgentToolsCeilingSchema>

export const ChatIntentSchema = z.enum([
  'answer',
  'capability',
  'explore',
  'edit',
  'review',
  'run'
])
export type ChatIntent = z.infer<typeof ChatIntentSchema>

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Empty = models.defaultModel. Use builtin:composer-lite or builtin:composer. */
  model: z.string(),
  temperature: z.number().min(0).max(2).nullable(),
  enabled: z.boolean(),
  builtin: z.boolean(),
  systemPrompt: z.string(),
  keywords: z.array(z.string()),
  /** Max tool access this agent may use (policy ceiling). */
  tools: AgentToolsCeilingSchema.default('edit'),
  /** When true and chat model is Lite, allow escalate tools role to Full. */
  preferEscalate: z.boolean().default(true)
})

export const ProjectAgentsSchema = z.object({
  version: z.number().int().positive(),
  orchestrator: AgentDefinitionSchema,
  subagents: z.array(AgentDefinitionSchema)
})

export const ModelConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['builtin', 'openai-compatible']),
  /** UI preset hint: ollama | lmstudio | openai | openrouter | groq | together | deepseek | custom */
  provider: z.string(),
  enabled: z.boolean(),
  baseUrl: z.string(),
  /** Key name in local secrets.json, never raw secret in settings JSON */
  apiKeyRef: z.string(),
  models: z.array(z.string())
})

export const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'sse', 'http']),
  /** stdio: command to launch (e.g. npx, uvx, node) */
  command: z.string(),
  args: z.array(z.string()),
  /** sse/http: server URL */
  url: z.string(),
  /** Extra env vars (values may be secret refs later) */
  env: z.record(z.string()),
  notes: z.string()
})

export const LanguageServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  /** LSP languageId sent in didOpen (python, go, rust, …) */
  languageId: z.string().min(1),
  /** File extensions without the dot */
  extensions: z.array(z.string()),
  command: z.string(),
  args: z.array(z.string())
})

export const SettingsSchema = z.object({
  models: z.object({
    defaultModel: z.string(),
    temperature: z.number().min(0).max(2),
    contextWindow: z.number().int().min(512).max(128000),
    connections: z.array(ModelConnectionSchema),
    /** Prefer an attached eGPU (or discrete GPU) for Local / Composer GGUFs. */
    preferEgpu: z.boolean().default(true)
  }),
  agent: z.object({
    systemPrompt: z.string(),
    includeOpenFiles: z.boolean(),
    maxHistoryMessages: z.number().int().min(2).max(200),
    /** When true, agent file changes are kept automatically (no review required) */
    autoKeepDiffs: z.boolean(),
    /** ask = prompt before agent shell commands / pushes (safe commands skip); auto = never prompt */
    commandApproval: z.enum(['ask', 'auto']),
    /** Exact commands the user chose "Always allow" for (workspace scope) */
    allowedCommands: z.array(z.string()),
    /** Constrain local (GGUF) tool-call retries to valid JSON via a grammar. */
    constrainLocalToolCalls: z.boolean().default(true),
    routing: z.object({
      enabled: z.boolean(),
      mode: z.enum(['auto', 'manual', 'off']),
      routerModel: z.string(),
      useLlmRouter: z.boolean(),
      fallbackAgentId: z.string().min(1)
    })
  }),
  intelligence: z.object({
    /** auto = embeddingModel on a connection when set, else local hashed vectors */
    embeddingProvider: z.enum(['auto', 'local', 'connection']),
    /** Model name served by a connection, e.g. nomic-embed-text on Ollama */
    embeddingModel: z.string(),
    /** Extra language servers; TypeScript/JavaScript is built in */
    languageServers: z.array(LanguageServerSchema)
  }),
  evals: z.object({
    /** Prefer the model with the best eval success rate for a turn's intent */
    useScoresForRouting: z.boolean(),
    /** Runs per model × intent before scores influence routing */
    minRuns: z.number().int().min(1).max(50),
    /** Let eval agents run commands that would normally need approval */
    allowUnsafeCommands: z.boolean()
  }),
  backgroundAgents: z.object({
    maxParallel: z.number().int().min(1).max(6),
    /** Symlink the workspace node_modules into each worktree */
    linkNodeModules: z.boolean()
  }),
  mcp: z.object({
    servers: z.array(McpServerSchema)
  }),
  github: z.object({
    /** github.com or GitHub Enterprise host */
    host: z.string(),
    /** Local secrets.json key for personal access token */
    tokenRef: z.string(),
    preferredProtocol: z.enum(['https', 'ssh']),
    /** Workspace: owner/repo (e.g. acme/app) */
    repository: z.string(),
    remoteName: z.string(),
    defaultBranch: z.string(),
    /** When true, project is linked to the repository above */
    linked: z.boolean()
  }),
  /** EricServic.es Control Hub account link + profile settings sync */
  ericServices: z.object({
    /** Origin for the site API, e.g. https://www.ericservic.es */
    apiBase: z.string(),
    /** Local secrets.json key for Eris API bearer token (eseris_…) */
    tokenRef: z.string(),
    linked: z.boolean(),
    username: z.string(),
    email: z.string(),
    /** ISO timestamp from last successful pull/push */
    lastSyncedAt: z.string(),
    /** When true, pull remote settings on login / Sync Now */
    syncEnabled: z.boolean(),
    /**
     * Plan from www.ericservic.es (admin pulldown Free/Pro on the account).
     * Synced from profile.erisPlan on login /me.
     */
    plan: z.enum(['free', 'pro']),
    /** Optional Free-tier overrides from profile.erisLimits (null fields = use defaults). */
    planLimits: z
      .object({
        dailyRequests: z.number().int().nonnegative().nullable().optional(),
        dailyTokens: z.number().int().nonnegative().nullable().optional(),
        cloudJobsPerDay: z.number().int().nonnegative().nullable().optional()
      })
      .optional()
  }),
  editor: z.object({
    fontSize: z.number().int().min(10).max(32),
    tabSize: z.number().int().min(1).max(8),
    theme: z.enum(['vs-dark', 'vs', 'hc-black']),
    /** Debounced as-you-type ghost completions (⌥\\ still forces one). */
    inlineSuggest: z.boolean()
  }),
  general: z.object({
    restoreLastWorkspace: z.boolean(),
    /** GitHub Releases auto-update (electron-updater) */
    updates: z.object({
      /** Periodically check GitHub for a newer release */
      autoCheck: z.boolean(),
      /** Download in the background when an update is found */
      autoDownload: z.boolean(),
      /** stable = tagged releases only; beta = also offer GitHub prereleases */
      channel: z.enum(['stable', 'beta']).default('stable')
    }),
    logging: z.object({
      enabled: z.boolean(),
      /** Empty = app default logs folder under Application Support */
      directory: z.string(),
      level: z.enum(['debug', 'info', 'warn', 'error'])
    }),
    /** Opt-in: record anonymous agent-run outcomes locally to improve routing. */
    telemetry: z
      .object({
        agentOutcomes: z.boolean().default(false)
      })
      .default({ agentOutcomes: false })
  })
})

export type AppSettings = z.infer<typeof SettingsSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>
export type ProjectAgentsConfig = z.infer<typeof ProjectAgentsSchema>
export type ModelConnection = z.infer<typeof ModelConnectionSchema>
export type McpServerConfig = z.infer<typeof McpServerSchema>
export type LanguageServerConfig = z.infer<typeof LanguageServerSchema>
export type SubagentConfig = AgentDefinition

export type SettingsScope = 'user' | 'workspace'

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type SettingsPatch = DeepPartial<AppSettings>

export interface WorkspaceMeta {
  openFiles: string[]
  activeFile: string | null
  activeChatId: string | null
  lastModel: string | null
}

export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  createdAt: number
  lastOpenedAt: number
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Collapsible model/tool trace shown under Thinking */
  thinking?: string
  createdAt: number
  agentId?: string
  agentName?: string
  model?: string
}

export interface ChatThread {
  id: string
  title: string
  model: string
  messages: ChatMessage[]
  updatedAt: number
  createdAt: number
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
}

export interface ModelInfo {
  name: string
  size?: number
  modifiedAt?: string
  source?: 'builtin' | 'local' | 'connection'
  connectionId?: string
  ready?: boolean
}

export interface GpuDeviceInfo {
  name: string
  kind: 'integrated' | 'discrete' | 'external'
  bus?: string
  vramBytes?: number
  index: number
}

/** eGPU / discrete GPU detection for Local model acceleration. */
export interface GpuAccelStatus {
  devices: GpuDeviceInfo[]
  egpu: GpuDeviceInfo | null
  preferredGpu: GpuDeviceInfo | null
  preferEgpu: boolean
  egpuDetected: boolean
  /** eGPU present and a GPU backend can use it for Local models. */
  egpuUsable: boolean
  /** eGPU or discrete GPU can accelerate Local models with current preference. */
  accelUsable: boolean
  backend: 'metal' | 'cuda' | 'vulkan' | false | null
  backendDeviceName: string | null
  message: string
}

export interface ModelsStatus {
  ok: boolean
  error?: string
  builtin: BuiltinModelStatus[]
  /** User-downloaded GGUFs that run inside Eris (no Ollama). */
  local?: LocalModelStatus[]
  models: ModelInfo[]
  connections: Array<ModelConnection & { reachable?: boolean; error?: string }>
  /** Local GGUF GPU / eGPU acceleration probe. */
  gpu?: GpuAccelStatus
}

export interface RouteResult {
  agentId: string
  agentName: string
  model: string
  reason: string
  method: 'manual' | 'heuristic' | 'llm' | 'default'
}

/** Central routing decision for one chat turn (main-process authority). */
export interface TurnPlan {
  intent: ChatIntent
  agentId: string
  agentName: string
  mode: 'ask' | 'agent'
  models: {
    chat: string
    tools: string
    router?: string
  }
  /** Effective tool ceiling after intersecting agent policy + intent + mode. */
  toolPolicy: AgentToolsCeiling
  requiresTools: boolean
  escalateToFull: boolean
  reason: string
  method: 'manual' | 'heuristic' | 'llm' | 'default' | 'override' | 'learned' | 'eval' | 'telemetry'
  /** Intent the classifier picked before any override / learned correction */
  classifiedIntent?: ChatIntent
  /** Set when the selected chat model cannot run (e.g. builtin not downloaded). */
  error?: string
}

export interface ChatTurnContext {
  text: string
  fileNames?: string[]
  manualAgentId?: string | null
  selectedModel: string
  mode: 'ask' | 'agent'
  /** User override from "Needed tools" / "Just a question" */
  forceRoute?: 'tools' | 'answer'
}

/** Structured chat turn; the main process assembles the final prompt from this. */
export interface ChatPromptInput {
  text: string
  mode: 'ask' | 'agent'
  agentId: string
  agentName?: string
  skillIds: string[]
  /** Active editor tab (may hold unsaved content) */
  openFile?: { path: string; language?: string; content: string } | null
  /** content set when the file is open in a tab; otherwise main reads from disk */
  attachments: Array<{ path: string; name: string; language?: string; content?: string }>
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  /** Continue a persisted, unfinished agent run */
  resumeRunId?: string
}

export interface ResolvedAgent extends AgentDefinition {
  resolvedModel: string
  role: 'orchestrator' | 'specialist'
  source: 'builtin' | 'project'
}

export interface BuiltinModelManifestEntry {
  id: string
  ref: string
  name: string
  displayName: string
  description: string
  family: string
  quant: string
  parameters: string
  contextWindow: number
  filename: string
  downloadUrl: string
  approxBytes: number
  sha256: string | null
  role: string
  /** lite = small/fast; full = larger quality model */
  tier?: 'lite' | 'full'
}

export interface BuiltinModelStatus {
  id: string
  ref: string
  name: string
  displayName: string
  description: string
  family: string
  parameters: string
  quant: string
  filename: string
  downloadUrl: string
  approxBytes: number
  installed: boolean
  ready: boolean
  localPath: string | null
  downloadedBytes: number
  progress: number
  tier?: 'lite' | 'full'
  /** True while a download is in progress (survives Settings close). */
  downloading?: boolean
  /** Last download error for this model, if any. */
  downloadError?: string | null
}

/** Curated GGUF that downloads/runs inside Eris (Settings → Local models). */
export interface LocalModelManifestEntry {
  id: string
  ref: string
  name: string
  displayName: string
  description: string
  family: string
  quant: string
  parameters: string
  contextWindow: number
  filename: string
  downloadUrl: string
  approxBytes: number
  sha256: string | null
  sizeLabel: string
}

export interface LocalModelStatus {
  id: string
  ref: string
  name: string
  displayName: string
  description: string
  family: string
  parameters: string
  quant: string
  filename: string
  downloadUrl: string
  approxBytes: number
  sizeLabel: string
  installed: boolean
  ready: boolean
  localPath: string | null
  downloadedBytes: number
  progress: number
  downloading?: boolean
  downloadError?: string | null
}

/** Hugging Face Hub GGUF search hit (Settings → Local models). */
export interface HfGgufSearchHit {
  repoId: string
  url: string
  downloads: number
  likes: number
  name: string
}

export type SkillScope = 'user' | 'workspace'

export interface SkillRecord {
  id: string
  name: string
  description: string
  body: string
  content: string
  scope: SkillScope
  path: string
  updatedAt: number
}

export interface SkillInput {
  id?: string
  name: string
  description: string
  body: string
  scope: SkillScope
}
