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
    label: 'AI',
    items: ['models', 'usage', 'agent', 'subagents', 'skills']
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
  models: 'Models',
  usage: 'Usage',
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
  models: 'Built-in Composer, Ollama, and cloud providers',
  usage: 'Plan limits and daily model usage',
  agent: 'Routing, Cloud Agents, and background jobs',
  subagents: 'Project specialists in .eris/agents.json',
  skills: 'Skill files that teach specialized workflows',
  context: 'Pinned summary and workspace context for the agent',
  rules: 'Always-on project rules the agent must follow',
  mcp: 'Model Context Protocol servers for the agent',
  github: 'Link this project to a GitHub repository',
  workspace: 'Project files under .eris/ for this folder',
  editor: 'Editor appearance, tabs, and suggestions'
}

/** Pages that use the generic layered SettingRows list. */
export const SETTINGS_ROWS_CATEGORIES = new Set<Category>([
  'general',
  'logging',
  'models',
  'agent',
  'editor'
])

/** Show user/workspace scope controls. */
export const SETTINGS_SCOPE_CATEGORIES = new Set<Category>([
  'general',
  'logging',
  'models',
  'agent',
  'editor'
])

/** Extra keywords so global Settings search can jump to custom pages. */
export const SETTINGS_PAGE_KEYWORDS: Record<Category, string[]> = {
  general: ['updates', 'setup', 'wizard', 'startup', 'restore'],
  account: ['login', 'sign in', 'eric', 'sync', 'plan', 'pro'],
  feedback: ['bug', 'report', 'issue', 'idea'],
  logging: ['logs', 'debug', 'trace', 'directory'],
  models: ['composer', 'ollama', 'openai', 'temperature', 'download'],
  usage: ['quota', 'limits', 'tokens', 'upgrade'],
  agent: ['routing', 'cloud', 'background', 'approval'],
  subagents: ['specialist', 'orchestrator', 'agents.json'],
  skills: ['skill', 'workflow', 'SKILL.md'],
  context: ['pin', 'summary', 'context.md', 'notes'],
  rules: ['rules', 'standards', 'always-on'],
  mcp: ['mcp', 'protocol', 'server', 'tools'],
  github: ['git', 'repository', 'pr', 'pull request'],
  workspace: ['.eris', 'project', 'folder'],
  editor: ['font', 'theme', 'tab', 'inline', 'suggest', 'ghost']
}
