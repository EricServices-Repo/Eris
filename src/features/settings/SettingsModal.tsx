import { useEffect, useMemo, useState } from 'react'
import type {
  AgentDefinition,
  AppSettings,
  McpServerConfig,
  ModelsStatus,
  ProjectAgentsConfig,
  SettingsPatch,
  SettingsScope,
  SkillRecord,
  SkillScope
} from '@/shared/settings-schema'
import type { LayeredSettings } from '@/shared/api'
import { ModelConnectionsPanel } from './ModelConnectionsPanel'
import { OllamaConfigPanel } from './OllamaConfigPanel'
import { GitHubSettingsPanel } from './GitHubSettingsPanel'
import { EricServicesAccountPanel } from './EricServicesAccountPanel'
import { UsagePanel } from './UsagePanel'

type Category =
  | 'general'
  | 'account'
  | 'models'
  | 'usage'
  | 'agent'
  | 'subagents'
  | 'skills'
  | 'rules'
  | 'context'
  | 'mcp'
  | 'github'
  | 'editor'
  | 'workspace'

function emptyMcpServer(): McpServerConfig {
  return {
    id: `mcp-${Date.now().toString(36)}`,
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    env: {},
    notes: ''
  }
}

interface Props {
  open: boolean
  hasWorkspace: boolean
  initialCategory?: Category
  startCreateSkill?: boolean
  onClose: () => void
  onChanged: (resolved: AppSettings) => void
  onRerunSetup?: () => void
}

function getAt(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function setAt(path: string[], value: unknown): SettingsPatch {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let i = 0; i < path.length - 1; i++) {
    cursor[path[i]] = {}
    cursor = cursor[path[i]] as Record<string, unknown>
  }
  cursor[path[path.length - 1]] = value
  return root as SettingsPatch
}

function AgentEditor({
  agent,
  role,
  models,
  defaultModel,
  onChange,
  onRemove
}: {
  agent: AgentDefinition
  role: 'orchestrator' | 'specialist'
  models: string[]
  defaultModel: string
  onChange: (next: AgentDefinition) => void
  onRemove?: () => void
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 10,
        background: 'var(--bg)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong>{agent.name || agent.id}</strong>
          <span className="badge">{role}</span>
          {agent.builtin && <span className="badge">default</span>}
          <span className="badge">{agent.id}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={agent.enabled}
              onChange={(e) => onChange({ ...agent, enabled: e.target.checked })}
            />
            Enabled
          </label>
          {onRemove && (
            <button className="btn-ghost" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Name</label>
        <input value={agent.name} onChange={(e) => onChange({ ...agent, name: e.target.value })} />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Model</label>
        <input
          list="ollama-models"
          value={agent.model}
          placeholder={defaultModel || 'uses default model'}
          onChange={(e) => onChange({ ...agent, model: e.target.value })}
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Temperature</label>
        <input
          type="number"
          step={0.1}
          min={0}
          max={2}
          value={agent.temperature ?? ''}
          placeholder="default"
          onChange={(e) =>
            onChange({
              ...agent,
              temperature: e.target.value === '' ? null : Number(e.target.value)
            })
          }
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Description</label>
        <input
          value={agent.description}
          onChange={(e) => onChange({ ...agent, description: e.target.value })}
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Keywords</label>
        <input
          value={agent.keywords.join(', ')}
          placeholder="implement, refactor, bug"
          onChange={(e) =>
            onChange({
              ...agent,
              keywords: e.target.value
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
            })
          }
        />
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Tools</label>
        <select
          value={agent.tools ?? 'edit'}
          onChange={(e) =>
            onChange({
              ...agent,
              tools: e.target.value as AgentDefinition['tools']
            })
          }
          title="Max tool access this agent may use"
        >
          <option value="none">none — answer only</option>
          <option value="read">read — inspect files</option>
          <option value="edit">edit — read + write</option>
          <option value="full">full — edit + shell/git sync</option>
        </select>
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>Escalate</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={agent.preferEscalate !== false}
            onChange={(e) => onChange({ ...agent, preferEscalate: e.target.checked })}
          />
          Allow Lite → Full for tools
        </label>
      </div>
      <div className="setting-row" style={{ gridTemplateColumns: '120px 1fr', border: 'none' }}>
        <label>System prompt</label>
        <textarea
          rows={4}
          value={agent.systemPrompt}
          onChange={(e) => onChange({ ...agent, systemPrompt: e.target.value })}
        />
      </div>
      <datalist id="ollama-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}

export function SettingsModal({
  open,
  hasWorkspace,
  initialCategory,
  startCreateSkill,
  onClose,
  onChanged,
  onRerunSetup
}: Props) {
  const [category, setCategory] = useState<Category>('models')
  const [layered, setLayered] = useState<LayeredSettings | null>(null)
  const [scope, setScope] = useState<SettingsScope>('user')
  const [status, setStatus] = useState<ModelsStatus | null>(null)
  const [search, setSearch] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [projectAgents, setProjectAgents] = useState<ProjectAgentsConfig | null>(null)
  const [agentsDirty, setAgentsDirty] = useState(false)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [skillDraft, setSkillDraft] = useState<{
    name: string
    description: string
    body: string
    scope: SkillScope
  } | null>(null)
  const [skillCreating, setSkillCreating] = useState(false)
  const [skillDirty, setSkillDirty] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [skillSaving, setSkillSaving] = useState(false)
  const [logsInfo, setLogsInfo] = useState<Awaited<ReturnType<typeof window.ide.getLogsInfo>> | null>(
    null
  )
  const [logContent, setLogContent] = useState('')
  const [logPath, setLogPath] = useState('')
  const [logTruncated, setLogTruncated] = useState(false)
  const [selectedLogFile, setSelectedLogFile] = useState<string>('')
  const [logsLoading, setLogsLoading] = useState(false)

  const loadLogs = async (fileName?: string) => {
    setLogsLoading(true)
    try {
      const [info, file] = await Promise.all([
        window.ide.getLogsInfo(),
        window.ide.readLogs(fileName || undefined)
      ])
      setLogsInfo(info)
      setLogContent(file.content)
      setLogPath(file.path)
      setLogTruncated(file.truncated)
      const name = file.path.split('/').pop() || ''
      setSelectedLogFile(name)
    } finally {
      setLogsLoading(false)
    }
  }

  const beginCreateSkill = (nextScope: SkillScope = hasWorkspace ? 'workspace' : 'user') => {
    setSkillCreating(true)
    setSelectedSkillId(null)
    setSkillDraft({
      name: '',
      description: 'Brief description of what this skill does and when to use it',
      body: '# New skill\n\n## Instructions\n\nTell the agent how to perform this task.\n',
      scope: nextScope
    })
    setSkillDirty(true)
    setSkillError(null)
  }

  const loadSkills = async (preferId?: string | null, preferCreate?: boolean) => {
    try {
      const list = await window.ide.listSkills()
      setSkills(list)
      setSkillError(null)
      if (preferCreate) {
        beginCreateSkill(hasWorkspace ? 'workspace' : 'user')
        return
      }
      const pick =
        (preferId && list.find((s) => s.id === preferId)) ||
        (selectedSkillId && list.find((s) => s.id === selectedSkillId)) ||
        list[0] ||
        null
      if (pick) {
        setSelectedSkillId(pick.id)
        setSkillCreating(false)
        setSkillDraft({
          name: pick.name,
          description: pick.description,
          body: pick.body,
          scope: pick.scope
        })
        setSkillDirty(false)
      } else {
        setSelectedSkillId(null)
        setSkillDraft(null)
        setSkillCreating(false)
        setSkillDirty(false)
      }
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to load skills')
    }
  }

  const load = async () => {
    const [layers, models, agents] = await Promise.all([
      window.ide.getLayeredSettings(),
      window.ide.modelsStatus().catch(() => null),
      window.ide.getProjectAgents().catch(() => null)
    ])
    setLayered(layers)
    if (models) setStatus(models)
    setProjectAgents(agents)
    setAgentsDirty(false)
    setAgentsError(null)
    if (category === 'general' || open) {
      void loadLogs(selectedLogFile || undefined)
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
  }, [open])

  useEffect(() => {
    if (!open) return
    if (startCreateSkill) {
      setCategory('skills')
      void loadSkills(null, true)
      return
    }
    if (initialCategory) {
      setCategory(initialCategory)
      if (initialCategory === 'skills') void loadSkills(null, false)
      if (initialCategory === 'rules') void loadRules()
      if (initialCategory === 'context') {
        void loadWorkspaceContextDoc()
        void loadEmailSources()
      }
    }
  }, [open, initialCategory, startCreateSkill])

  useEffect(() => {
    if (open && category === 'rules') void loadRules()
  }, [open, category, hasWorkspace])

  useEffect(() => {
    if (open && category === 'context') {
      void loadWorkspaceContextDoc()
      void loadEmailSources()
    }
  }, [open, category, hasWorkspace])

  useEffect(() => {
    if (!open || category !== 'mcp') return
    void window.ide.mcpStatus().then(setMcpRuntime).catch(() => setMcpRuntime(null))
  }, [open, category, layered?.resolved?.mcp])

  useEffect(() => {
    if (open && category === 'skills' && !skillCreating && !skillDraft) {
      void loadSkills(selectedSkillId, false)
    }
  }, [category])

  useEffect(() => {
    if (open && category === 'general') void loadLogs(selectedLogFile || undefined)
  }, [open, category])

  useEffect(() => {
    if (!open) return
    return window.ide.onBuiltinDownloadProgress((s) => {
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              builtin: prev.builtin.map((b) => (b.id === s.id ? s : b))
            }
          : prev
      )
    })
  }, [open])

  useEffect(() => {
    if (!hasWorkspace && scope === 'workspace') setScope('user')
  }, [hasWorkspace, scope])

  const resolved = layered?.resolved

  const apply = async (path: string[], value: unknown) => {
    // Always keep all / EricServic.es account are user preferences — never workspace.
    const saveScope: SettingsScope =
      (path[0] === 'agent' && path[1] === 'autoKeepDiffs') || path[0] === 'ericServices'
        ? 'user'
        : scope
    const next = await window.ide.setSettings(saveScope, setAt(path, value))
    onChanged(next)
    await load()
  }

  const saveAgents = async () => {
    if (!projectAgents) return
    try {
      const saved = await window.ide.saveProjectAgents(projectAgents)
      setProjectAgents(saved)
      setAgentsDirty(false)
      setAgentsError(null)
      const next = await window.ide.getResolvedSettings()
      onChanged(next)
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : 'Failed to save project agents')
    }
  }

  const categories: { id: Category; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'account', label: 'Account' },
    { id: 'models', label: 'Models' },
    { id: 'usage', label: 'Usage' },
    { id: 'agent', label: 'Agent' },
    { id: 'subagents', label: 'Subagents' },
    { id: 'skills', label: 'Skills' },
    { id: 'rules', label: 'Rules' },
    { id: 'context', label: 'Context' },
    { id: 'mcp', label: 'MCP' },
    { id: 'github', label: 'GitHub' },
    { id: 'editor', label: 'Editor' },
    { id: 'workspace', label: 'Workspace' }
  ]

  const [rules, setRules] = useState<Array<{ id: string; name: string; body: string }>>([])
  const [ruleDraft, setRuleDraft] = useState<{
    id?: string
    name: string
    body: string
  } | null>(null)
  const [ruleError, setRuleError] = useState<string | null>(null)
  const [ruleSaving, setRuleSaving] = useState(false)
  const [mcpDraft, setMcpDraft] = useState<McpServerConfig | null>(null)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [mcpRuntime, setMcpRuntime] = useState<Awaited<
    ReturnType<typeof window.ide.mcpStatus>
  > | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)

  const loadRules = async () => {
    if (!hasWorkspace) {
      setRules([])
      return
    }
    try {
      setRules(await window.ide.listRules())
    } catch {
      setRules([])
    }
  }

  const [contextBody, setContextBody] = useState('')
  const [contextPin, setContextPin] = useState('')
  const [contextDirty, setContextDirty] = useState(false)
  const [contextSaving, setContextSaving] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [contextNote, setContextNote] = useState('')
  const [emailSources, setEmailSources] = useState<
    Array<{
      kind: 'thunderbird' | 'outlook' | 'eml'
      id: string
      label: string
      path?: string
      available: boolean
      detail?: string
    }>
  >([])
  const [emailSourceId, setEmailSourceId] = useState('')
  const [emailQuery, setEmailQuery] = useState('')
  const [emailMax, setEmailMax] = useState(15)
  const [emailEmlFolder, setEmailEmlFolder] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailStatus, setEmailStatus] = useState<string | null>(null)

  const loadWorkspaceContextDoc = async () => {
    if (!hasWorkspace) {
      setContextBody('')
      setContextPin('')
      setContextDirty(false)
      return
    }
    try {
      const doc = await window.ide.getWorkspaceContext()
      setContextBody(doc.body)
      setContextPin(doc.pin)
      setContextDirty(false)
      setContextError(null)
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to load context')
    }
  }

  const loadEmailSources = async (emlFolder?: string) => {
    try {
      const sources = await window.ide.emailDiscoverSources(emlFolder || emailEmlFolder || undefined)
      setEmailSources(sources)
      const available = sources.filter((s) => s.available)
      if (!emailSourceId || !sources.some((s) => s.id === emailSourceId && s.available)) {
        const preferred =
          available.find((s) => s.kind === 'thunderbird') ||
          available.find((s) => s.kind === 'outlook') ||
          available[0]
        if (preferred) setEmailSourceId(preferred.id)
      }
    } catch (err) {
      setEmailStatus(err instanceof Error ? err.message : 'Failed to discover email sources')
    }
  }

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) ?? null,
    [skills, selectedSkillId]
  )

  const saveSkill = async () => {
    if (!skillDraft) return
    const name = skillDraft.name.trim()
    if (!name) {
      setSkillError('Name is required')
      return
    }
    if (skillDraft.scope === 'workspace' && !hasWorkspace) {
      setSkillError('Open a workspace to save a project skill')
      return
    }
    setSkillSaving(true)
    setSkillError(null)
    try {
      if (skillCreating) {
        const created = await window.ide.createSkill({
          name,
          description: skillDraft.description,
          body: skillDraft.body,
          scope: skillDraft.scope
        })
        setSkillCreating(false)
        setSelectedSkillId(created.id)
        await loadSkills(created.id)
      } else if (selectedSkill) {
        const updated = await window.ide.updateSkill(selectedSkill.id, selectedSkill.scope, {
          name,
          description: skillDraft.description,
          body: skillDraft.body
        })
        setSelectedSkillId(updated.id)
        await loadSkills(updated.id)
      }
      setSkillDirty(false)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to save skill')
    } finally {
      setSkillSaving(false)
    }
  }

  const removeSkill = async () => {
    if (!selectedSkill || skillCreating) return
    const ok = window.confirm(`Delete skill “${selectedSkill.name}”? This cannot be undone.`)
    if (!ok) return
    try {
      await window.ide.deleteSkill(selectedSkill.id, selectedSkill.scope)
      setSelectedSkillId(null)
      setSkillDraft(null)
      await loadSkills(null)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to delete skill')
    }
  }

  const agentIds = useMemo(() => {
    if (!projectAgents) return ['orchestrator']
    return [projectAgents.orchestrator.id, ...projectAgents.subagents.map((a) => a.id)]
  }, [projectAgents])

  const rows = useMemo(() => {
    if (!resolved) return []
    const all = [
      {
        cat: 'general' as Category,
        label: 'Restore last workspace',
        hint: 'Reopen the previous folder on launch',
        path: ['general', 'restoreLastWorkspace'],
        type: 'boolean' as const
      },
      {
        cat: 'general' as Category,
        label: 'Enable file logging',
        hint: 'Write app events to a daily log file',
        path: ['general', 'logging', 'enabled'],
        type: 'boolean' as const
      },
      {
        cat: 'general' as Category,
        label: 'Log level',
        hint: 'Minimum severity written to disk',
        path: ['general', 'logging', 'level'],
        type: 'select' as const,
        options: ['debug', 'info', 'warn', 'error']
      },
      {
        cat: 'models' as Category,
        label: 'Default model',
        hint: 'builtin:composer-lite (~1 GB) or builtin:composer (~4.7 GB)',
        path: ['models', 'defaultModel'],
        type: 'string' as const
      },
      {
        cat: 'models' as Category,
        label: 'Temperature',
        hint: 'Default sampling temperature for agents without an override',
        path: ['models', 'temperature'],
        type: 'number' as const
      },
      {
        cat: 'models' as Category,
        label: 'Context window',
        hint: 'Tokens available to the model',
        path: ['models', 'contextWindow'],
        type: 'number' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Shared system prompt',
        hint: 'Prefixed for every agent before its own prompt',
        path: ['agent', 'systemPrompt'],
        type: 'textarea' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Include open files',
        hint: 'Attach active editor content to chat context',
        path: ['agent', 'includeOpenFiles'],
        type: 'boolean' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Always keep all changes',
        hint: 'Skip review — keep every agent edit as it lands (user setting)',
        path: ['agent', 'autoKeepDiffs'],
        type: 'boolean' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Max history messages',
        hint: 'Trim older turns from context',
        path: ['agent', 'maxHistoryMessages'],
        type: 'number' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Enable routing',
        hint: 'Route messages to the orchestrator or a specialist',
        path: ['agent', 'routing', 'enabled'],
        type: 'boolean' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Routing mode',
        hint: 'auto picks an agent; manual uses the composer picker',
        path: ['agent', 'routing', 'mode'],
        type: 'select' as const,
        options: ['auto', 'manual', 'off']
      },
      {
        cat: 'agent' as Category,
        label: 'Fallback agent',
        hint: 'Used when routing is off or no keywords match',
        path: ['agent', 'routing', 'fallbackAgentId'],
        type: 'select' as const,
        options: agentIds
      },
      {
        cat: 'agent' as Category,
        label: 'Use LLM router',
        hint: 'Ask routerModel to classify intent + agent (falls back to heuristics)',
        path: ['agent', 'routing', 'useLlmRouter'],
        type: 'boolean' as const
      },
      {
        cat: 'agent' as Category,
        label: 'Router model',
        hint: 'Empty = default model. Prefer a small/fast Ollama model.',
        path: ['agent', 'routing', 'routerModel'],
        type: 'string' as const
      },
      {
        cat: 'editor' as Category,
        label: 'Font size',
        path: ['editor', 'fontSize'],
        type: 'number' as const,
        hint: 'Editor font size in pixels'
      },
      {
        cat: 'editor' as Category,
        label: 'Tab size',
        path: ['editor', 'tabSize'],
        type: 'number' as const,
        hint: 'Spaces per tab'
      },
      {
        cat: 'editor' as Category,
        label: 'Theme',
        path: ['editor', 'theme'],
        type: 'select' as const,
        options: ['vs-dark', 'vs', 'hc-black'],
        hint: 'Monaco color theme'
      },
      {
        cat: 'editor' as Category,
        label: 'Inline suggestions',
        path: ['editor', 'inlineSuggest'],
        type: 'boolean' as const,
        hint: 'As-you-type ghost completions (⌥\\ still forces one)'
      }
    ]
    return all.filter((r) => {
      if (r.cat !== category) return false
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return r.label.toLowerCase().includes(q) || r.hint.toLowerCase().includes(q)
    })
  }, [resolved, category, search, agentIds])

  if (!open || !resolved || !layered) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-nav">
          <div style={{ padding: '4px 10px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
            SETTINGS
          </div>
          {categories.map((c) => (
            <button
              key={c.id}
              className={category === c.id ? 'active' : ''}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Close</button>
        </div>
        <div className="modal-content">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
            <div>
              <h2>{categories.find((c) => c.id === category)?.label}</h2>
              <div className="subtitle">
                {category === 'subagents'
                  ? 'Project agents live in .eris/agents.json'
                  : category === 'skills'
                    ? 'Skill files teach the agent specialized workflows (SKILL.md)'
                    : category === 'mcp'
                      ? 'Model Context Protocol servers available to the agent'
                      : category === 'github'
                        ? 'Link this project to a GitHub repository'
                        : category === 'account'
                          ? 'Link your EricServic.es profile and sync preferences'
                          : category === 'usage'
                            ? 'Daily model requests and token estimates by type'
                            : 'Cursor-style layered config: defaults → user → workspace'}
              </div>
            </div>
            {category !== 'subagents' &&
              category !== 'skills' &&
              category !== 'mcp' &&
              category !== 'github' &&
              category !== 'account' &&
              category !== 'usage' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  placeholder="Search settings"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: 160 }}
                />
                <select
                  className="scope-select"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as SettingsScope)}
                  title="Where to write changes"
                >
                  <option value="user">User</option>
                  <option value="workspace" disabled={!hasWorkspace}>
                    Workspace
                  </option>
                </select>
              </div>
            )}
          </div>

          {category === 'usage' && <UsagePanel />}

          {category === 'models' && (
            <div className="models-page" style={{ marginBottom: 16 }}>
              <div className="models-page-section">
                <div className="model-connections-intro">
                  <strong>Built-in Composer</strong>
                  <p>
                    Runs locally in Eris.{' '}
                    <strong>Lite</strong> is the chat face (~1 GB).{' '}
                    <strong>Full</strong> (~4.7 GB) is the worker that finishes multi-file tool work.
                    Keep Lite as the default; download and verify Full for reliable agent edits.
                  </p>
                </div>
              {(status?.builtin ?? []).map((b) => {
                const sizeLabel =
                  b.approxBytes >= 1e9
                    ? `~${(b.approxBytes / 1e9).toFixed(1)} GB`
                    : `~${Math.round(b.approxBytes / 1e6)} MB`
                const isDefault = resolved?.models.defaultModel === b.ref
                const isDownloading = downloadingId === b.id
                return (
                  <div
                    key={b.id}
                    style={{
                      marginBottom: 12,
                      padding: 12,
                      border: `1px solid ${isDefault ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 8,
                      background: 'var(--bg)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span className={`status-dot ${b.ready ? 'ok' : ''}`} />
                      <strong>{b.displayName}</strong>
                      <span className="badge">built-in</span>
                      {b.tier && <span className="badge">{b.tier}</span>}
                      {isDefault && <span className="badge">default</span>}
                      <span className="badge">
                        {b.family} · {b.parameters} · {b.quant}
                      </span>
                    </div>
                    <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                      {b.description}
                    </p>
                    <div style={{ color: 'var(--text-muted)', marginBottom: 8, fontSize: 12 }}>
                      {b.ready
                        ? `Ready · ${b.filename}`
                        : b.installed
                          ? `Invalid / incomplete file · re-download ${sizeLabel}`
                          : `Not installed · ${sizeLabel} download into app data`}
                      {isDownloading && b.progress > 0
                        ? ` · ${Math.round(b.progress * 100)}%`
                        : ''}
                    </div>
                    {!b.ready && b.progress > 0 && b.progress < 1 && (
                      <div
                        style={{
                          height: 6,
                          borderRadius: 999,
                          background: 'var(--bg-hover)',
                          marginBottom: 8,
                          overflow: 'hidden'
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.round(b.progress * 100)}%`,
                            height: '100%',
                            background: 'var(--accent)'
                          }}
                        />
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {b.ready ? (
                        <>
                          <button className="btn" onClick={() => void load()}>
                            Refresh
                          </button>
                          <button
                            className="btn"
                            disabled={verifyingId === b.id}
                            onClick={() => {
                              setVerifyingId(b.id)
                              void window.ide
                                .verifyBuiltinModel(b.id)
                                .then((result) => {
                                  if (result.ok) {
                                    window.alert(
                                      `${b.displayName} checksum OK` +
                                        (result.digest ? `\n${result.digest.slice(0, 16)}…` : '')
                                    )
                                  } else {
                                    window.alert(result.error || 'Verification failed')
                                  }
                                  return load()
                                })
                                .catch((err: unknown) => {
                                  window.alert(
                                    err instanceof Error ? err.message : 'Verification failed'
                                  )
                                })
                                .finally(() => setVerifyingId(null))
                            }}
                          >
                            {verifyingId === b.id ? 'Verifying…' : 'Verify checksum'}
                          </button>
                          {b.tier === 'lite' && !isDefault && (
                            <button
                              className="btn btn-primary"
                              onClick={() => void apply(['models', 'defaultModel'], b.ref)}
                            >
                              Use as chat default
                            </button>
                          )}
                          {b.tier === 'full' && (
                            <span className="badge" title="Full runs as the workspace worker when ready">
                              worker when ready
                            </span>
                          )}
                          <button
                            className="btn"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete ${b.displayName} from disk? You can download it again later.`
                                )
                              ) {
                                void window.ide.deleteBuiltinModel(b.id).then(() => load())
                              }
                            }}
                          >
                            Delete
                          </button>
                        </>
                      ) : isDownloading || (downloadingId && downloadingId !== b.id) ? (
                        isDownloading ? (
                          <button
                            className="btn"
                            onClick={() => {
                              void window.ide.cancelBuiltinDownload()
                              setDownloadingId(null)
                            }}
                          >
                            Cancel download
                          </button>
                        ) : (
                          <button className="btn" disabled>
                            Waiting…
                          </button>
                        )
                      ) : (
                        <button
                          className="btn btn-primary"
                          onClick={() => {
                            setDownloadingId(b.id)
                            void window.ide
                              .downloadBuiltinModel(b.id)
                              .then(async () => {
                                await load()
                                const currentDefault = resolved?.models.defaultModel
                                // Lite stays the chat default; Full is the worker, not promoted.
                                const shouldPromote =
                                  b.tier === 'lite' &&
                                  (!currentDefault?.startsWith('builtin:') ||
                                    currentDefault === b.ref ||
                                    currentDefault === 'builtin:composer')
                                if (shouldPromote) {
                                  await apply(['models', 'defaultModel'], b.ref)
                                }
                              })
                              .catch((err: unknown) => {
                                window.alert(
                                  err instanceof Error ? err.message : 'Download failed'
                                )
                              })
                              .finally(() => setDownloadingId(null))
                          }}
                        >
                          {b.installed ? 'Re-download' : 'Download'}{' '}
                          {b.tier === 'lite' ? 'Lite' : b.name} ({sizeLabel})
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              </div>

              {resolved && (
                <OllamaConfigPanel
                  resolved={resolved}
                  status={status}
                  defaultModel={resolved.models.defaultModel}
                  onSaveConnections={async (connections) => {
                    await apply(['models', 'connections'], connections)
                  }}
                  onRefresh={async () => {
                    await load()
                  }}
                  onSetDefaultModel={async (model) => {
                    await apply(['models', 'defaultModel'], model)
                  }}
                />
              )}

              <ModelConnectionsPanel
                resolved={resolved}
                status={status}
                defaultModel={resolved.models.defaultModel}
                onSaveConnections={async (connections) => {
                  await apply(['models', 'connections'], connections)
                }}
                onRefresh={async () => {
                  await load()
                }}
                onSetDefaultModel={async (model) => {
                  await apply(['models', 'defaultModel'], model)
                }}
              />
            </div>
          )}

          {category === 'agent' && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg)',
                color: 'var(--text-muted)',
                lineHeight: 1.45
              }}
            >
              Routing picks an <strong style={{ color: 'var(--text)' }}>orchestrator</strong> or{' '}
              <strong style={{ color: 'var(--text)' }}>specialist</strong> from the project agent
              config. Edit specialists under Subagents.
            </div>
          )}

          {category === 'workspace' && (
            <div className="subtitle">
              Workspace overrides: <code>.eris/settings.json</code>. Agents:{' '}
              <code>.eris/agents.json</code>. Context: <code>.eris/context.md</code>. Rules:{' '}
              <code>.eris/rules/*.md</code>. Skills: <code>.eris/skills/*/SKILL.md</code>.
              {!hasWorkspace && ' Open a folder to edit project-scoped files.'}
            </div>
          )}

          {category === 'context' && (
            <div className="workspace-context-panel">
              <p className="subtitle" style={{ marginTop: 0 }}>
                Durable project memory in <code>.eris/context.md</code>. Only the{' '}
                <strong>## Summary</strong> pin (~800 chars) is injected every turn; full notes stay
                on disk for <code>read_context</code> / reference.
                {!hasWorkspace && ' Open a workspace to edit.'}
              </p>
              {!hasWorkspace ? (
                <div className="subtitle">No workspace open.</div>
              ) : (
                <>
                  {contextPin ? (
                    <div className="workspace-context-pin">
                      <div className="explorer-section-label">Pinned each turn</div>
                      <pre>{contextPin}</pre>
                    </div>
                  ) : (
                    <div className="subtitle">No summary pin yet — fill in ## Summary below.</div>
                  )}
                  <label className="field">
                    <span>context.md</span>
                    <textarea
                      rows={16}
                      value={contextBody}
                      spellCheck={false}
                      onChange={(e) => {
                        setContextBody(e.target.value)
                        setContextDirty(true)
                      }}
                    />
                  </label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!contextDirty || contextSaving}
                      onClick={() => {
                        setContextSaving(true)
                        void window.ide
                          .saveWorkspaceContext(contextBody)
                          .then((doc) => {
                            setContextBody(doc.body)
                            setContextPin(doc.pin)
                            setContextDirty(false)
                            setContextError(null)
                          })
                          .catch((err: unknown) => {
                            setContextError(
                              err instanceof Error ? err.message : 'Failed to save context'
                            )
                          })
                          .finally(() => setContextSaving(false))
                      }}
                    >
                      {contextSaving ? 'Saving…' : 'Save context'}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={contextSaving}
                      onClick={() => void loadWorkspaceContextDoc()}
                    >
                      Reload
                    </button>
                  </div>
                  <label className="field">
                    <span>Quick append note</span>
                    <input
                      value={contextNote}
                      placeholder="e.g. Auth lives in src/lib/auth.ts"
                      onChange={(e) => setContextNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || !contextNote.trim()) return
                        e.preventDefault()
                        void window.ide
                          .appendWorkspaceContextNote(contextNote)
                          .then((doc) => {
                            setContextBody(doc.body)
                            setContextPin(doc.pin)
                            setContextNote('')
                            setContextDirty(false)
                          })
                          .catch((err: unknown) => {
                            setContextError(
                              err instanceof Error ? err.message : 'Failed to append note'
                            )
                          })
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    disabled={!contextNote.trim() || contextSaving}
                    onClick={() => {
                      void window.ide
                        .appendWorkspaceContextNote(contextNote)
                        .then((doc) => {
                          setContextBody(doc.body)
                          setContextPin(doc.pin)
                          setContextNote('')
                          setContextDirty(false)
                        })
                        .catch((err: unknown) => {
                          setContextError(
                            err instanceof Error ? err.message : 'Failed to append note'
                          )
                        })
                    }}
                  >
                    Append note
                  </button>

                  <div className="github-section" style={{ marginTop: 20 }}>
                    <h3>Email context</h3>
                    <p className="model-conn-hint">
                      Pull recent mail from Thunderbird (local profiles) or Outlook (AppleScript /
                      .eml export). Writes <code>.eris/email-context.md</code> and a digest under{' '}
                      <code>## Email</code> in context. The agent can call <code>read_email</code>.
                    </p>
                    <label className="field">
                      <span>Source</span>
                      <select
                        value={emailSourceId}
                        onChange={(e) => setEmailSourceId(e.target.value)}
                        disabled={emailBusy}
                      >
                        {emailSources.map((s) => (
                          <option key={s.id} value={s.id} disabled={!s.available && s.kind !== 'eml'}>
                            {s.label}
                            {!s.available ? ' (unavailable)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    {emailSources.find((s) => s.id === emailSourceId)?.detail && (
                      <p className="model-conn-hint" style={{ marginTop: 0 }}>
                        {emailSources.find((s) => s.id === emailSourceId)?.detail}
                      </p>
                    )}
                    <div className="model-conn-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={emailBusy}
                        onClick={() =>
                          void (async () => {
                            const picked = await window.ide.emailPickEmlFolder()
                            if (!picked.ok || !picked.path) return
                            setEmailEmlFolder(picked.path)
                            setEmailSourceId(`eml:${picked.path}`)
                            await loadEmailSources(picked.path)
                            setEmailStatus(`Using .eml folder: ${picked.path}`)
                          })()
                        }
                      >
                        Choose .eml folder…
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={emailBusy}
                        onClick={() => void loadEmailSources()}
                      >
                        Refresh sources
                      </button>
                    </div>
                    <label className="field">
                      <span>Filter (optional — subject / from / body)</span>
                      <input
                        value={emailQuery}
                        onChange={(e) => setEmailQuery(e.target.value)}
                        placeholder="e.g. invoice, support@, Eris"
                        disabled={emailBusy}
                      />
                    </label>
                    <label className="field">
                      <span>Max messages</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={emailMax}
                        onChange={(e) => setEmailMax(Number(e.target.value) || 15)}
                        disabled={emailBusy}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={emailBusy || !emailSourceId || !hasWorkspace}
                      onClick={() =>
                        void (async () => {
                          setEmailBusy(true)
                          setEmailStatus(null)
                          try {
                            let sourceId = emailSourceId
                            if (sourceId === 'eml:folder' && emailEmlFolder) {
                              sourceId = `eml:${emailEmlFolder}`
                            }
                            const result = await window.ide.emailPull({
                              sourceId,
                              query: emailQuery.trim() || undefined,
                              maxMessages: emailMax,
                              appendToContext: true
                            })
                            if (!result.ok) {
                              setEmailStatus(result.error || 'Pull failed')
                              return
                            }
                            setEmailStatus(
                              result.messages.length
                                ? `Pulled ${result.messages.length} message(s) into context`
                                : result.error || 'No messages'
                            )
                            await loadWorkspaceContextDoc()
                          } catch (err) {
                            setEmailStatus(
                              err instanceof Error ? err.message : 'Email pull failed'
                            )
                          } finally {
                            setEmailBusy(false)
                          }
                        })()
                      }
                    >
                      {emailBusy ? 'Pulling…' : 'Pull email into context'}
                    </button>
                    {emailStatus && (
                      <p className="model-conn-hint" style={{ marginTop: 8 }}>
                        {emailStatus}
                      </p>
                    )}
                  </div>

                  {contextError && (
                    <div className="subtitle" style={{ color: 'var(--danger)', marginTop: 8 }}>
                      {contextError}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {category === 'rules' && (
            <div className="skills-panel">
              <p className="subtitle" style={{ marginTop: 0 }}>
                Workspace rules live in <code>.eris/rules/*.md</code> and are injected into every agent
                chat. {!hasWorkspace && 'Open a workspace to edit rules.'}
              </p>
              {!hasWorkspace ? (
                <div className="subtitle">No workspace open.</div>
              ) : (
                <div className="skills-layout">
                  <div className="skills-list">
                    <div className="skills-list-header">
                      <span className="explorer-section-label" style={{ margin: 0 }}>
                        Rules
                      </span>
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => {
                          setRuleDraft({ name: 'project', body: '# Project rules\n\n- \n' })
                          setRuleError(null)
                        }}
                      >
                        New rule
                      </button>
                    </div>
                    {rules.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className={`skill-list-item ${ruleDraft?.id === r.id ? 'active' : ''}`}
                        onClick={() => {
                          setRuleDraft({ id: r.id, name: r.name, body: r.body })
                          setRuleError(null)
                        }}
                      >
                        <strong>{r.name}</strong>
                        <span className="badge">.md</span>
                      </button>
                    ))}
                  </div>
                  <div className="skills-editor">
                    {ruleDraft ? (
                      <>
                        <label className="field">
                          <span>Name</span>
                          <input
                            value={ruleDraft.name}
                            onChange={(e) =>
                              setRuleDraft({ ...ruleDraft, name: e.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Body</span>
                          <textarea
                            rows={16}
                            value={ruleDraft.body}
                            onChange={(e) =>
                              setRuleDraft({ ...ruleDraft, body: e.target.value })
                            }
                            spellCheck={false}
                          />
                        </label>
                        {ruleError && <div className="subtitle" style={{ color: 'var(--danger)' }}>{ruleError}</div>}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={ruleSaving}
                            onClick={() => {
                              void (async () => {
                                setRuleSaving(true)
                                setRuleError(null)
                                try {
                                  const saved = await window.ide.saveRule(
                                    ruleDraft.name,
                                    ruleDraft.body,
                                    ruleDraft.id
                                  )
                                  setRuleDraft({
                                    id: saved.id,
                                    name: saved.name,
                                    body: saved.body
                                  })
                                  await loadRules()
                                } catch (err) {
                                  setRuleError(
                                    err instanceof Error ? err.message : 'Save failed'
                                  )
                                } finally {
                                  setRuleSaving(false)
                                }
                              })()
                            }}
                          >
                            Save
                          </button>
                          {ruleDraft.id && (
                            <button
                              className="btn"
                              type="button"
                              onClick={() => {
                                void (async () => {
                                  await window.ide.deleteRule(ruleDraft.id!)
                                  setRuleDraft(null)
                                  await loadRules()
                                })()
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="subtitle">Select a rule or create a new one.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {category === 'mcp' && resolved && (
            <div className="skills-panel">
              <p className="subtitle" style={{ marginTop: 0 }}>
                Configure and connect MCP servers (stdio / SSE / HTTP). Live tools are exposed to the
                agent as <code>mcp__server__tool</code> names.
              </p>
              {mcpRuntime && (
                <div className="mcp-status-list">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong style={{ fontSize: 12 }}>Runtime</strong>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void window.ide
                          .mcpReconnect()
                          .then(setMcpRuntime)
                          .catch(() => undefined)
                      }
                    >
                      Reconnect
                    </button>
                    <span className="subtitle" style={{ margin: 0 }}>
                      {mcpRuntime.tools.length} tool(s)
                    </span>
                  </div>
                  {mcpRuntime.servers.length === 0 ? (
                    <div className="subtitle">No enabled servers connected.</div>
                  ) : (
                    mcpRuntime.servers.map((s) => (
                      <div key={s.id} className="mcp-status-row">
                        <span className={`status-dot ${s.connected ? 'ok' : ''}`} />
                        <strong>{s.name}</strong>
                        <span className="badge">{s.transport}</span>
                        <span className="badge">{s.toolCount} tools</span>
                        {s.error && (
                          <span style={{ color: 'var(--danger)' }}>{s.error}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                <select
                  className="scope-select"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as SettingsScope)}
                >
                  <option value="user">User</option>
                  <option value="workspace" disabled={!hasWorkspace}>
                    Workspace
                  </option>
                </select>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => {
                    setMcpDraft(emptyMcpServer())
                    setMcpError(null)
                  }}
                >
                  Add server
                </button>
              </div>
              {mcpError && (
                <div className="subtitle" style={{ color: 'var(--danger)' }}>
                  {mcpError}
                </div>
              )}
              <div className="skills-layout">
                <div className="skills-list">
                  <div className="skills-list-header">
                    <span className="explorer-section-label" style={{ margin: 0 }}>
                      Servers
                    </span>
                  </div>
                  {(resolved.mcp?.servers ?? []).length === 0 && !mcpDraft && (
                    <div className="subtitle" style={{ padding: '8px 0' }}>
                      No MCP servers yet.
                    </div>
                  )}
                  {(resolved.mcp?.servers ?? []).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={`skill-list-item ${mcpDraft?.id === s.id ? 'active' : ''}`}
                      onClick={() => {
                        setMcpDraft({ ...s, args: [...s.args], env: { ...s.env } })
                        setMcpError(null)
                      }}
                    >
                      <strong>{s.name || s.id}</strong>
                      <span className="badge">{s.transport}</span>
                      {s.enabled ? (
                        <span className="badge">on</span>
                      ) : (
                        <span className="badge">off</span>
                      )}
                    </button>
                  ))}
                  {mcpDraft && !(resolved.mcp?.servers ?? []).some((s) => s.id === mcpDraft.id) && (
                    <button className="skill-list-item active" type="button">
                      <strong>{mcpDraft.name || 'New server'}</strong>
                      <span className="badge">draft</span>
                    </button>
                  )}
                </div>
                <div className="skills-editor">
                  {mcpDraft ? (
                    <>
                      <label className="field">
                        <span>Name</span>
                        <input
                          value={mcpDraft.name}
                          onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>Enabled</span>
                        <input
                          type="checkbox"
                          checked={mcpDraft.enabled}
                          onChange={(e) =>
                            setMcpDraft({ ...mcpDraft, enabled: e.target.checked })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Transport</span>
                        <select
                          value={mcpDraft.transport}
                          onChange={(e) =>
                            setMcpDraft({
                              ...mcpDraft,
                              transport: e.target.value as McpServerConfig['transport']
                            })
                          }
                        >
                          <option value="stdio">stdio</option>
                          <option value="sse">sse</option>
                          <option value="http">http</option>
                        </select>
                      </label>
                      {mcpDraft.transport === 'stdio' ? (
                        <>
                          <label className="field">
                            <span>Command</span>
                            <input
                              value={mcpDraft.command}
                              placeholder="npx / uvx / node …"
                              onChange={(e) =>
                                setMcpDraft({ ...mcpDraft, command: e.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>Args (space-separated)</span>
                            <input
                              value={mcpDraft.args.join(' ')}
                              placeholder="-y @modelcontextprotocol/server-filesystem ."
                              onChange={(e) =>
                                setMcpDraft({
                                  ...mcpDraft,
                                  args: e.target.value
                                    .split(/\s+/)
                                    .map((a) => a.trim())
                                    .filter(Boolean)
                                })
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <label className="field">
                          <span>URL</span>
                          <input
                            value={mcpDraft.url}
                            placeholder="https://…"
                            onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                          />
                        </label>
                      )}
                      <label className="field">
                        <span>Env (KEY=value per line)</span>
                        <textarea
                          rows={3}
                          value={Object.entries(mcpDraft.env)
                            .map(([k, v]) => `${k}=${v}`)
                            .join('\n')}
                          onChange={(e) => {
                            const env: Record<string, string> = {}
                            for (const line of e.target.value.split('\n')) {
                              const i = line.indexOf('=')
                              if (i <= 0) continue
                              env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
                            }
                            setMcpDraft({ ...mcpDraft, env })
                          }}
                          spellCheck={false}
                        />
                      </label>
                      <label className="field">
                        <span>Notes</span>
                        <textarea
                          rows={2}
                          value={mcpDraft.notes}
                          onChange={(e) => setMcpDraft({ ...mcpDraft, notes: e.target.value })}
                        />
                      </label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={() => {
                            if (!mcpDraft.name.trim()) {
                              setMcpError('Name is required')
                              return
                            }
                            if (mcpDraft.transport === 'stdio' && !mcpDraft.command.trim()) {
                              setMcpError('Command is required for stdio')
                              return
                            }
                            if (
                              (mcpDraft.transport === 'sse' || mcpDraft.transport === 'http') &&
                              !mcpDraft.url.trim()
                            ) {
                              setMcpError('URL is required for SSE/HTTP')
                              return
                            }
                            setMcpError(null)
                            const servers = [...(resolved.mcp?.servers ?? [])]
                            const idx = servers.findIndex((s) => s.id === mcpDraft.id)
                            if (idx >= 0) servers[idx] = mcpDraft
                            else servers.push(mcpDraft)
                            void apply(['mcp', 'servers'], servers).then(() => {
                              setMcpDraft(null)
                            })
                          }}
                        >
                          Save
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => {
                            setMcpDraft(null)
                            setMcpError(null)
                          }}
                        >
                          Cancel
                        </button>
                        {(resolved.mcp?.servers ?? []).some((s) => s.id === mcpDraft.id) && (
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              const servers = (resolved.mcp?.servers ?? []).filter(
                                (s) => s.id !== mcpDraft.id
                              )
                              void apply(['mcp', 'servers'], servers).then(() => {
                                setMcpDraft(null)
                              })
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="subtitle">Select a server or add a new one.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {category === 'github' && resolved && (
            <GitHubSettingsPanel
              resolved={resolved}
              hasWorkspace={hasWorkspace}
              scope={scope}
              onScopeChange={setScope}
              onApply={apply}
              onChanged={async () => {
                await load()
              }}
            />
          )}

          {category === 'account' && resolved && (
            <EricServicesAccountPanel
              resolved={resolved}
              scope={scope}
              onScopeChange={setScope}
              onApply={apply}
              onChanged={async () => {
                await load()
              }}
            />
          )}

          {category === 'skills' && (
            <div className="skills-panel">
              <p className="subtitle" style={{ marginTop: 0 }}>
                User skills (default from chat):{' '}
                <code>~/Library/Application Support/Eris/skills</code> — outside every project.
                Project skills: <code>.eris/skills/*/SKILL.md</code>. In chat, say “create a skill…”
                or type <code>/create-skill</code>; the agent uses <code>write_skill</code> (no npm
                install).
              </p>
              <div className="skills-layout">
                <div className="skills-list">
                  <div className="skills-list-header">
                    <span className="explorer-section-label" style={{ margin: 0 }}>
                      Skills
                    </span>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => beginCreateSkill('user')}
                    >
                      New skill
                    </button>
                  </div>
                  {skills.length === 0 && !skillCreating && (
                    <div className="subtitle" style={{ padding: '8px 0' }}>
                      No skills yet. Create one to guide the agent.
                    </div>
                  )}
                  {skillCreating && (
                    <button className="skill-list-item active" type="button">
                      <strong>New skill</strong>
                      <span className="badge">draft</span>
                    </button>
                  )}
                  {skills.map((skill) => (
                    <button
                      key={`${skill.scope}:${skill.id}`}
                      type="button"
                      className={`skill-list-item ${
                        !skillCreating && selectedSkillId === skill.id ? 'active' : ''
                      }`}
                      onClick={() => {
                        if (skillDirty && !window.confirm('Discard unsaved skill changes?')) return
                        setSkillCreating(false)
                        setSelectedSkillId(skill.id)
                        setSkillDraft({
                          name: skill.name,
                          description: skill.description,
                          body: skill.body,
                          scope: skill.scope
                        })
                        setSkillDirty(false)
                        setSkillError(null)
                      }}
                    >
                      <span className="skill-list-main">
                        <strong>{skill.name}</strong>
                        <span className="hint">{skill.description || skill.id}</span>
                      </span>
                      <span className="badge">{skill.scope}</span>
                    </button>
                  ))}
                </div>
                <div className="skills-editor">
                  {!skillDraft ? (
                    <div className="subtitle">Select a skill or create a new one.</div>
                  ) : (
                    <>
                      <div className="skills-editor-toolbar">
                        <button
                          className="btn btn-primary"
                          type="button"
                          disabled={!skillDirty || skillSaving}
                          onClick={() => void saveSkill()}
                        >
                          {skillSaving ? 'Saving…' : skillCreating ? 'Create skill' : 'Save'}
                        </button>
                        {!skillCreating && selectedSkill && (
                          <button className="btn" type="button" onClick={() => void removeSkill()}>
                            Delete
                          </button>
                        )}
                        {skillDirty && <span className="badge">unsaved</span>}
                      </div>
                      {skillError && (
                        <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{skillError}</div>
                      )}
                      {skillCreating && (
                        <div className="setting-row" style={{ border: 'none', padding: '4px 0' }}>
                          <div>
                            <label>Scope</label>
                            <div className="hint">
                              User skills apply everywhere. Workspace skills live in the project.
                            </div>
                          </div>
                          <select
                            value={skillDraft.scope}
                            onChange={(e) => {
                              const next = e.target.value as SkillScope
                              if (next === 'workspace' && !hasWorkspace) return
                              setSkillDraft({ ...skillDraft, scope: next })
                              setSkillDirty(true)
                            }}
                          >
                            <option value="user">User</option>
                            <option value="workspace" disabled={!hasWorkspace}>
                              Workspace
                            </option>
                          </select>
                        </div>
                      )}
                      {!skillCreating && selectedSkill && (
                        <div className="subtitle" style={{ marginBottom: 8 }}>
                          <code>{selectedSkill.path}</code>
                        </div>
                      )}
                      <div className="form-stack">
                        <label>Name</label>
                        <input
                          value={skillDraft.name}
                          placeholder="my-skill"
                          onChange={(e) => {
                            setSkillDraft({ ...skillDraft, name: e.target.value })
                            setSkillDirty(true)
                          }}
                        />
                        <label>Description</label>
                        <textarea
                          rows={2}
                          value={skillDraft.description}
                          placeholder="When should the agent use this skill?"
                          onChange={(e) => {
                            setSkillDraft({ ...skillDraft, description: e.target.value })
                            setSkillDirty(true)
                          }}
                        />
                        <label>Instructions (SKILL.md body)</label>
                        <textarea
                          className="skill-body-editor"
                          rows={14}
                          value={skillDraft.body}
                          onChange={(e) => {
                            setSkillDraft({ ...skillDraft, body: e.target.value })
                            setSkillDirty(true)
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {category === 'subagents' && (
            <div style={{ marginBottom: 16 }}>
              {!hasWorkspace ? (
                <div className="subtitle">
                  Open a workspace to edit project agents. Bundled defaults from{' '}
                  <code>resources/agents.json</code> are used until then.
                </div>
              ) : (
                <>
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      marginBottom: 12,
                      flexWrap: 'wrap',
                      alignItems: 'center'
                    }}
                  >
                    <button className="btn btn-primary" disabled={!agentsDirty} onClick={() => void saveAgents()}>
                      Save project agents
                    </button>
                    <button
                      className="btn"
                      onClick={() =>
                        void window.ide.resetProjectAgents().then((cfg) => {
                          setProjectAgents(cfg)
                          setAgentsDirty(false)
                        })
                      }
                    >
                      Reset to defaults
                    </button>
                    {agentsDirty && <span className="badge">unsaved</span>}
                  </div>
                  {agentsError && (
                    <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{agentsError}</div>
                  )}
                  <p className="subtitle" style={{ marginTop: 0 }}>
                    Defaults ship with the app and are copied into{' '}
                    <code>.eris/agents.json</code> for each workspace. Customize models and prompts
                    per project.
                  </p>
                  {projectAgents && (
                    <>
                      <div className="explorer-section-label">Orchestrator</div>
                      <AgentEditor
                        agent={projectAgents.orchestrator}
                        role="orchestrator"
                        models={status?.models.map((m) => m.name) ?? []}
                        defaultModel={resolved.models.defaultModel}
                        onChange={(next) => {
                          setProjectAgents({ ...projectAgents, orchestrator: next })
                          setAgentsDirty(true)
                        }}
                      />
                      <div className="explorer-section-label">Specialists</div>
                      {projectAgents.subagents.map((agent, index) => (
                        <AgentEditor
                          key={agent.id}
                          agent={agent}
                          role="specialist"
                          models={status?.models.map((m) => m.name) ?? []}
                          defaultModel={resolved.models.defaultModel}
                          onChange={(next) => {
                            const subagents = projectAgents.subagents.map((a, i) =>
                              i === index ? next : a
                            )
                            setProjectAgents({ ...projectAgents, subagents })
                            setAgentsDirty(true)
                          }}
                          onRemove={
                            agent.builtin
                              ? undefined
                              : () => {
                                  setProjectAgents({
                                    ...projectAgents,
                                    subagents: projectAgents.subagents.filter((_, i) => i !== index)
                                  })
                                  setAgentsDirty(true)
                                }
                          }
                        />
                      ))}
                      <button
                        className="btn"
                        onClick={() => {
                          const id = `custom-${Date.now().toString(36)}`
                          setProjectAgents({
                            ...projectAgents,
                            subagents: [
                              ...projectAgents.subagents,
                              {
                                id,
                                name: 'Custom specialist',
                                description: 'Project-specific subagent',
                                model: '',
                                temperature: null,
                                enabled: true,
                                builtin: false,
                                tools: 'edit',
                                preferEscalate: true,
                                systemPrompt: 'You are a project specialist in Eris.',
                                keywords: []
                              }
                            ]
                          })
                          setAgentsDirty(true)
                        }}
                      >
                        Add specialist
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {category === 'general' && (
            <div className="logs-panel">
              {onRerunSetup && (
                <div className="github-section" style={{ marginBottom: 16 }}>
                  <h3>Setup wizard</h3>
                  <p className="model-conn-hint">
                    Re-run the first-time guide to download Composer models and open a workspace.
                  </p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      onClose()
                      onRerunSetup()
                    }}
                  >
                    Run setup wizard again
                  </button>
                </div>
              )}
              <div className="logs-panel-header">
                <strong>App logs</strong>
                <span className="hint">
                  {logsInfo
                    ? `Writing to ${logsInfo.directory}`
                    : 'Daily log files for chat, models, and workspace events'}
                </span>
              </div>

              <div className="setting-row" style={{ border: 'none', padding: '8px 0' }}>
                <div>
                  <label>Log directory</label>
                  <div className="hint">
                    Leave empty for the default folder under Application Support. Current:{' '}
                    <code>{logsInfo?.directory || '…'}</code>
                  </div>
                </div>
                <div className="logs-path-controls">
                  <input
                    value={resolved.general.logging.directory}
                    placeholder={logsInfo?.defaultDirectory || 'Default app logs folder'}
                    onChange={(e) => void apply(['general', 'logging', 'directory'], e.target.value)}
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void window.ide.pickLogsDirectory().then(async (dir) => {
                        if (!dir) return
                        await apply(['general', 'logging', 'directory'], dir)
                        await loadLogs()
                      })
                    }
                  >
                    Browse…
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void apply(['general', 'logging', 'directory'], '').then(() => loadLogs())
                    }
                  >
                    Use default
                  </button>
                </div>
              </div>

              <div className="logs-toolbar">
                <select
                  value={selectedLogFile}
                  onChange={(e) => {
                    const name = e.target.value
                    setSelectedLogFile(name)
                    void loadLogs(name || undefined)
                  }}
                >
                  {(logsInfo?.files.length ? logsInfo.files : [{ name: selectedLogFile || 'today' }]).map(
                    (f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                        {'size' in f && typeof f.size === 'number'
                          ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB`
                          : ''}
                      </option>
                    )
                  )}
                </select>
                <button className="btn" type="button" disabled={logsLoading} onClick={() => void loadLogs(selectedLogFile || undefined)}>
                  Refresh
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void window.ide.openLogsFolder()}
                >
                  Open folder
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Clear all log files in this directory? This cannot be undone.'
                      )
                    ) {
                      void window.ide.clearLogs().then(() => loadLogs())
                    }
                  }}
                >
                  Clear logs
                </button>
              </div>

              {logTruncated && (
                <div className="hint" style={{ marginBottom: 6 }}>
                  Showing the end of the file (truncated for display).
                </div>
              )}
              <pre className="logs-viewer" title={logPath}>
                {logsLoading
                  ? 'Loading…'
                  : logContent.trim()
                    ? logContent
                    : 'No log entries yet. Use the app (chat, workspaces, settings) and refresh.'}
              </pre>
            </div>
          )}

          {category !== 'subagents' &&
            rows.map((row) => {
              const value = getAt(resolved, row.path)
              const overridden =
                getAt(layered.workspace, row.path) !== undefined
                  ? 'workspace'
                  : getAt(layered.user, row.path) !== undefined
                    ? 'user'
                    : 'default'
              return (
                <div className="setting-row" key={row.path.join('.')}>
                  <div>
                    <label>{row.label}</label>
                    <div className="hint">
                      {row.hint} · <span className="badge">{overridden}</span>
                    </div>
                  </div>
                  {row.type === 'boolean' && (
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) => void apply(row.path, e.target.checked)}
                    />
                  )}
                  {row.type === 'string' && (
                    <input
                      value={String(value ?? '')}
                      onChange={(e) => void apply(row.path, e.target.value)}
                    />
                  )}
                  {row.type === 'number' && (
                    <input
                      type="number"
                      value={Number(value)}
                      step={row.path.includes('temperature') ? 0.1 : 1}
                      onChange={(e) => void apply(row.path, Number(e.target.value))}
                    />
                  )}
                  {row.type === 'textarea' && (
                    <textarea
                      rows={4}
                      value={String(value ?? '')}
                      onChange={(e) => void apply(row.path, e.target.value)}
                    />
                  )}
                  {row.type === 'select' && (
                    <select
                      value={String(value)}
                      onChange={(e) => void apply(row.path, e.target.value)}
                    >
                      {row.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    className="btn-ghost"
                    disabled={overridden === 'default'}
                    onClick={() =>
                      void window.ide
                        .resetSettingKey(overridden === 'workspace' ? 'workspace' : 'user', row.path)
                        .then(async (next) => {
                          onChanged(next)
                          await load()
                        })
                    }
                  >
                    Reset
                  </button>
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
