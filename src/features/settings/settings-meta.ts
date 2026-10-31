import type { Category } from './fields'

export type SettingsNavGroup = {
  label: string
  items: Category[]
}

/** Sidebar order and groupings. */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'App',
    items: ['general', 'account', 'feedback', 'logging']
  },
  {
    label: 'Models',
    items: ['gpu', 'composer', 'textModels', 'imageModels']
  },
  {
    label: 'AI',
    items: ['providers', 'usage', 'memory', 'agent', 'subagents', 'skills']
  },
  {
    label: 'Project',
    items: ['context', 'rules', 'mcp', 'github', 'workspace']
  },
  {
    label: 'Editor',
    items: ['editor']
  }
]

export const SETTINGS_LABELS: Record<Category, string> = {
  general: 'General',
  account: 'Account',
  feedback: 'Feedback',
  logging: 'Logging',
  gpu: 'GPUs',
  composer: 'Composer',
  textModels: 'Text Models',
  imageModels: 'Image Models',
  providers: 'Providers',
  usage: 'Usage',
  memory: 'Memory',
  agent: 'Agent',
  subagents: 'Subagents',
  skills: 'Skills',
  context: 'Context',
  rules: 'Rules',
  mcp: 'MCP',
  github: 'GitHub',
  workspace: 'Workspace',
  editor: 'Editor'
}

export const SETTINGS_SUBTITLES: Record<Category, string> = {
  general: 'Startup, updates, and everyday preferences',
  account: 'EricServic.es profile, plan, and sync',
  feedback: 'Report bugs and ideas without leaving Eris',
  logging: 'App log files, level, and directory',
  gpu: 'Detected graphics hardware, VRAM, acceleration, and eGPU preference',
  composer: 'Built-in Composer Lite / Full and default chat model',
  textModels: 'Download local GGUF chat and coding models from Hugging Face',
  imageModels: 'Configure image generation and download local Diffusers models',
  providers: 'Optional cloud APIs and local servers (LM Studio, Ollama)',
  usage: 'Plan limits and 30-day model usage',
  memory: 'Conversation RAM, saved history, recall, and privacy',
  agent: 'Routing, Cloud Agents, and background jobs',
  subagents: 'Project specialists in .eris/agents.json',
  skills: 'Skill files that teach specialized workflows',
  context: 'Pinned summary and workspace context for the agent',
  rules: 'Always-on project rules the agent must follow',
  mcp: 'Model Context Protocol servers for the agent',
  github: 'Link this project to a GitHub repository',
  workspace: 'Project files under .eris/ for this folder',
  editor: 'Editor appearance, chat fonts, tabs, and suggestions'
}

/** Pages that use the generic layered SettingRows list. */
export const SETTINGS_ROWS_CATEGORIES = new Set<Category>([
  'general',
  'logging',
  'composer',
  'agent',
  'editor'
])

/** Show user/workspace scope controls. */
export const SETTINGS_SCOPE_CATEGORIES = new Set<Category>([
  'general',
  'logging',
  'gpu',
  'composer',
  'textModels',
  'imageModels',
  'providers',
  'agent',
  'editor'
])

/** Extra keywords so global Settings search can jump to custom pages. */
export const SETTINGS_PAGE_KEYWORDS: Record<Category, string[]> = {
  general: ['updates', 'setup', 'wizard', 'startup', 'restore'],
  account: ['login', 'sign in', 'eric', 'sync', 'plan', 'pro'],
  feedback: ['bug', 'report', 'issue', 'idea'],
  logging: ['logs', 'debug', 'trace', 'directory'],
  gpu: ['gpu', 'egpu', 'metal', 'cuda', 'vram', 'graphics', 'acceleration'],
  composer: ['composer', 'lite', 'full', 'builtin', 'temperature', 'download', 'models'],
  textModels: ['local', 'gguf', 'qwen', 'llama', 'gemma', 'phi', 'huggingface', 'download'],
  imageModels: [
    'image',
    'generation',
    'stable diffusion',
    'sdxl',
    'diffusers',
    'huggingface',
    'download',
    'api'
  ],
  providers: [
    'ollama',
    'openai',
    'openrouter',
    'lm studio',
    'api',
    'endpoint',
    'groq',
    'anthropic',
    'connection'
  ],
  usage: ['quota', 'limits', 'tokens', 'upgrade'],
  memory: ['ram', 'history', 'cache', 'recall', 'memory', 'storage', 'budget', 'privacy'],
  agent: ['routing', 'cloud', 'background', 'approval'],
  subagents: ['specialist', 'orchestrator', 'agents.json'],
  skills: ['skill', 'workflow', 'SKILL.md'],
  context: ['pin', 'summary', 'context.md', 'notes'],
  rules: ['rules', 'standards', 'always-on'],
  mcp: ['mcp', 'protocol', 'server', 'tools'],
  github: ['git', 'repository', 'pr', 'pull request'],
  workspace: ['.eris', 'project', 'folder'],
  editor: ['font', 'theme', 'tab', 'inline', 'suggest', 'ghost', 'chat', 'serif', 'sans', 'mono']
}

/** Map legacy Settings category ids (e.g. openSettings('models')). */
export function resolveSettingsCategory(id: string | undefined): Category | undefined {
  if (!id) return undefined
  if (id === 'models') return 'composer'
  if (id === 'localModels') return 'textModels'
  if (id in SETTINGS_LABELS) return id as Category
  return undefined
}
