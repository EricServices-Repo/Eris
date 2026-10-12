/* eslint-disable react-hooks/exhaustive-deps -- effects below fire on open/category transitions;
   the loaders are plain per-render functions and must not retrigger them. */
import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  ModelsStatus,
  ProjectAgentsConfig,
  SettingsScope
} from '@/shared/settings-schema'
import type { LayeredSettings } from '@/shared/api'
import { GitHubSettingsPanel } from './GitHubSettingsPanel'
import { EricServicesAccountPanel } from './EricServicesAccountPanel'
import { UsagePanel } from './UsagePanel'
import { type Category, SettingRows, setAt, settingFields } from './fields'
import { AgentPanel } from './panels/AgentPanel'
import { ContextPanel, useContextPanelState } from './panels/ContextPanel'
import { GeneralPanel, useLogsState } from './panels/GeneralPanel'
import { McpPanel, useMcpPanelState } from './panels/McpPanel'
import { ModelsPanel, useModelsPanelState } from './panels/ModelsPanel'
import { RulesPanel, useRulesPanelState } from './panels/RulesPanel'
import { SkillsPanel, useSkillsPanelState } from './panels/SkillsPanel'
import { SubagentsPanel } from './panels/SubagentsPanel'
import { WorkspacePanel } from './panels/WorkspacePanel'

interface Props {
  open: boolean
  hasWorkspace: boolean
  /** Already-loaded app settings for instant paint before IPC returns. */
  seedResolved?: AppSettings | null
  initialCategory?: Category
  startCreateSkill?: boolean
  onClose: () => void
  onChanged: (resolved: AppSettings) => void
  onRerunSetup?: () => void
  onReportBug?: () => void
}

export function SettingsModal({
  open,
  hasWorkspace,
  seedResolved = null,
  initialCategory,
  startCreateSkill,
  onClose,
  onChanged,
  onRerunSetup,
  onReportBug
}: Props) {
  const [category, setCategory] = useState<Category>('models')
  const [layered, setLayered] = useState<LayeredSettings | null>(null)
  const [scope, setScope] = useState<SettingsScope>('user')
  const [status, setStatus] = useState<ModelsStatus | null>(null)
  const [search, setSearch] = useState('')
  const [projectAgents, setProjectAgents] = useState<ProjectAgentsConfig | null>(null)
  const [agentsDirty, setAgentsDirty] = useState(false)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const modelsState = useModelsPanelState()
  const skillsState = useSkillsPanelState(hasWorkspace)
  const logsState = useLogsState()
  const rulesState = useRulesPanelState(hasWorkspace)
  const mcpState = useMcpPanelState()
  const contextState = useContextPanelState(hasWorkspace)
  const { skillCreating, skillDraft, selectedSkillId, loadSkills } = skillsState
  const { selectedLogFile, loadLogs } = logsState
  const { loadRules } = rulesState
  const { setMcpRuntime } = mcpState
  const { loadWorkspaceContextDoc } = contextState

  const load = async () => {
    // Paint the shell as soon as layered settings return — do not wait on
    // modelsStatus (Ollama probe can take seconds when offline).
    const layersP = window.ide.getLayeredSettings()
    const modelsP = window.ide.modelsStatus().catch(() => null)
    const agentsP = window.ide.getProjectAgents().catch(() => null)

    const layers = await layersP
    setLayered(layers)
    setAgentsDirty(false)
    setAgentsError(null)

    const [models, agents] = await Promise.all([modelsP, agentsP])
    if (models) setStatus(models)
    setProjectAgents(agents)
  }

  useEffect(() => {
    if (!open) return
    // Instant shell from in-memory settings; IPC refresh fills layers/models next.
    if (!layered && seedResolved) {
      setLayered({
        defaults: seedResolved,
        user: {},
        workspace: {},
        resolved: seedResolved
      })
    }
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
      }
    }
  }, [open, initialCategory, startCreateSkill])

  useEffect(() => {
    if (open && category === 'rules') void loadRules()
  }, [open, category, hasWorkspace])

  useEffect(() => {
    if (open && category === 'context') {
      void loadWorkspaceContextDoc()
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

  const agentIds = useMemo(() => {
    if (!projectAgents) return ['orchestrator']
    return [projectAgents.orchestrator.id, ...projectAgents.subagents.map((a) => a.id)]
  }, [projectAgents])

  const rows = useMemo(() => {
    if (!resolved) return []
    return settingFields(agentIds).filter((r) => {
      if (r.cat !== category) return false
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return r.label.toLowerCase().includes(q) || r.hint.toLowerCase().includes(q)
    })
  }, [resolved, category, search, agentIds])

  if (!open) return null

  if (!resolved || !layered) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal settings-modal-loading" onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <h2>Settings</h2>
            <p className="subtitle">Loading…</p>
          </div>
        </div>
      </div>
    )
  }

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
                            ? 'Plan limits, Upgrade to Pro, and daily model usage'
                            : category === 'agent'
                              ? 'Routing, Cloud Agents status, and background agent limits'
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
            <ModelsPanel
              state={modelsState}
              resolved={resolved}
              status={status}
              apply={apply}
              load={load}
            />
          )}

          {category === 'agent' && <AgentPanel />}

          {category === 'workspace' && <WorkspacePanel hasWorkspace={hasWorkspace} />}

          {category === 'context' && (
            <ContextPanel state={contextState} hasWorkspace={hasWorkspace} />
          )}

          {category === 'rules' && <RulesPanel state={rulesState} hasWorkspace={hasWorkspace} />}

          {category === 'mcp' && resolved && (
            <McpPanel
              state={mcpState}
              resolved={resolved}
              hasWorkspace={hasWorkspace}
              scope={scope}
              setScope={setScope}
              apply={apply}
            />
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

          {category === 'skills' && <SkillsPanel state={skillsState} hasWorkspace={hasWorkspace} />}

          {category === 'subagents' && (
            <SubagentsPanel
              hasWorkspace={hasWorkspace}
              resolved={resolved}
              status={status}
              projectAgents={projectAgents}
              setProjectAgents={setProjectAgents}
              agentsDirty={agentsDirty}
              setAgentsDirty={setAgentsDirty}
              agentsError={agentsError}
              setAgentsError={setAgentsError}
              onChanged={onChanged}
            />
          )}

          {category === 'general' && (
            <GeneralPanel
              state={logsState}
              resolved={resolved}
              apply={apply}
              onClose={onClose}
              onRerunSetup={onRerunSetup}
              onReportBug={onReportBug}
            />
          )}

          {category !== 'subagents' && (
            <SettingRows
              rows={rows}
              resolved={resolved}
              layered={layered}
              apply={apply}
              onChanged={onChanged}
              onReload={load}
            />
          )}
        </div>
      </div>
    </div>
  )
}
