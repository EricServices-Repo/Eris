import { useDialogFocus } from '@/hooks/useDialogFocus'
/* eslint-disable react-hooks/exhaustive-deps -- effects below fire on open/category transitions;
   the loaders are plain per-render functions and must not retrigger them. */
import { useEffect, useId, useMemo, useState } from 'react'
import type {
  AppSettings,
  ModelsStatus,
  ProjectAgentsConfig,
  SettingsScope
} from '@/shared/settings-schema'
import type { LayeredSettings } from '@/shared/api'
import { mergeModelsDownloadStatus, upsertDownloadRow } from '@/shared/model-download-ui'
import { GitHubSettingsPanel } from './GitHubSettingsPanel'
import { EricServicesAccountPanel } from './EricServicesAccountPanel'
import { UsagePanel } from './UsagePanel'
import { ErisCloudPanel } from './ErisCloudPanel'
import { type Category, SettingRows, setAt, settingFields } from './fields'
import { MemoryPanel } from './panels/MemoryPanel'
import { AgentPanel } from './panels/AgentPanel'
import { ContextPanel, useContextPanelState } from './panels/ContextPanel'
import { FeedbackPanel } from './panels/FeedbackPanel'
import { GpuModelsPanel } from './panels/GpuModelsPanel'
import { GeneralPanel } from './panels/GeneralPanel'
import { LoggingPanel, useLogsState } from './panels/LoggingPanel'
import { McpPanel, useMcpPanelState } from './panels/McpPanel'
import {
  ComposerModelsPanel,
  ImageModelsPanel,
  ProvidersModelsPanel,
  TextModelsPanel
} from './panels/ModelsPanel'
import { resolveSettingsCategory } from './settings-meta'
import { RulesPanel, useRulesPanelState } from './panels/RulesPanel'
import { SkillsPanel, useSkillsPanelState } from './panels/SkillsPanel'
import { SubagentsPanel } from './panels/SubagentsPanel'
import { WorkspacePanel } from './panels/WorkspacePanel'
import { SettingsSection } from './SettingsSection'
import {
  SETTINGS_LABELS,
  SETTINGS_NAV,
  SETTINGS_PAGE_KEYWORDS,
  SETTINGS_ROWS_CATEGORIES,
  SETTINGS_SCOPE_CATEGORIES,
  SETTINGS_SUBTITLES
} from './settings-meta'

interface Props {
  open: boolean
  hasWorkspace: boolean
  activeThreadId?: string | null
  /** Already-loaded app settings for instant paint before IPC returns. */
  seedResolved?: AppSettings | null
  /** Accepts legacy model page ids and maps them to the new pages. */
  initialCategory?: Category | 'models' | 'localModels'
  startCreateSkill?: boolean
  onClose: () => void
  onChanged: (resolved: AppSettings) => void
  onRerunSetup?: () => void
}

export function SettingsModal({
  open,
  hasWorkspace,
  activeThreadId,
  seedResolved = null,
  initialCategory,
  startCreateSkill,
  onClose,
  onChanged,
  onRerunSetup
}: Props) {
  const dialogRef = useDialogFocus(onClose)
  const [category, setCategory] = useState<Category>('composer')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(
    () => SETTINGS_NAV.find(group => group.items.includes(category))?.label ?? null
  )
  const navId = useId()

  function selectCategory(next: Category) {
    setCategory(next)
    setExpandedGroup(SETTINGS_NAV.find(group => group.items.includes(next))?.label ?? null)
  }
  const [layered, setLayered] = useState<LayeredSettings | null>(null)
  const [scope, setScope] = useState<SettingsScope>('user')
  const [status, setStatus] = useState<ModelsStatus | null>(null)
  const [search, setSearch] = useState('')
  const [projectAgents, setProjectAgents] = useState<ProjectAgentsConfig | null>(null)
  const [agentsDirty, setAgentsDirty] = useState(false)
  const [agentsError, setAgentsError] = useState<string | null>(null)
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
    const layersP = window.ide.getLayeredSettings()
    const modelsP = window.ide.modelsStatus({ probe: true, includeGpu: true }).catch(() => null)
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
      selectCategory('skills')
      void loadSkills(null, true)
      return
    }
    if (initialCategory) {
      const resolvedCat = resolveSettingsCategory(initialCategory) || 'composer'
      selectCategory(resolvedCat)
      if (resolvedCat === 'skills') void loadSkills(null, false)
      if (resolvedCat === 'rules') void loadRules()
      if (resolvedCat === 'context') void loadWorkspaceContextDoc()
      if (resolvedCat === 'logging') void loadLogs()
    }
  }, [open, initialCategory, startCreateSkill])

  useEffect(() => {
    if (open && category === 'rules') void loadRules()
  }, [open, category, hasWorkspace])

  useEffect(() => {
    if (open && category === 'context') void loadWorkspaceContextDoc()
  }, [open, category, hasWorkspace])

  useEffect(() => {
    if (!open || category !== 'mcp') return
    void window.ide
      .mcpStatus()
      .then(setMcpRuntime)
      .catch(() => setMcpRuntime(null))
  }, [open, category, layered?.resolved?.mcp])

  useEffect(() => {
    if (open && category === 'skills' && !skillCreating && !skillDraft) {
      void loadSkills(selectedSkillId, false)
    }
  }, [category])

  useEffect(() => {
    if (open && category === 'logging') void loadLogs(selectedLogFile || undefined)
  }, [open, category])

  useEffect(() => {
    if (!open) return
    return window.ide.onLocalDownloadProgress((download) => {
      // A Hugging Face download can register an ID before the catalog contains it.
      setStatus((previous) => previous
        ? { ...previous, local: upsertDownloadRow(previous.local ?? [], download) }
        : { ok: true, builtin: [], local: [download], models: [], connections: [] })
    })
  }, [open])

  const localDownloadActive = Boolean(status?.local?.some((model) => model.downloading))
  // Use the light local snapshot to recover progress when Settings is reopened.
  useEffect(() => {
    if (!open || category !== 'textModels' || !localDownloadActive) return
    let cancelled = false
    const id = window.setInterval(() => {
      void window.ide.localModelStatus().then((local) => {
        if (cancelled) return
        setStatus((previous) => {
          if (!previous) return previous
          return mergeModelsDownloadStatus(previous, { ...previous, local })
        })
      }).catch(() => undefined)
    }, 1_500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [open, category, localDownloadActive])

  useEffect(() => {
    if (!hasWorkspace && scope === 'workspace') setScope('user')
  }, [hasWorkspace, scope])

  const resolved = layered?.resolved

  const apply = async (path: string[], value: unknown) => {
    const saveScope: SettingsScope =
      (path[0] === 'agent' && ['autoKeepDiffs', 'recoveryAcrossProviders'].includes(path[1] ?? '')) || path[0] === 'ericServices'
        ? 'user'
        : scope
    const next = await window.ide.setSettings(saveScope, setAt(path, value))
    onChanged(next)
    await load()
  }

  const agentIds = useMemo(() => {
    if (!projectAgents) return ['orchestrator']
    return [projectAgents.orchestrator.id, ...projectAgents.subagents.map((a) => a.id)]
  }, [projectAgents])

  const searchQuery = search.trim().toLowerCase()

  const pageHits = useMemo(() => {
    if (!searchQuery) return [] as Category[]
    return (Object.keys(SETTINGS_LABELS) as Category[]).filter((id) => {
      const hay = [
        SETTINGS_LABELS[id],
        SETTINGS_SUBTITLES[id],
        ...(SETTINGS_PAGE_KEYWORDS[id] || [])
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(searchQuery)
    })
  }, [searchQuery])

  const fieldHits = useMemo(() => {
    if (!searchQuery || !resolved) return []
    return settingFields(agentIds).filter(
      (r) =>
        r.label.toLowerCase().includes(searchQuery) || r.hint.toLowerCase().includes(searchQuery)
    )
  }, [searchQuery, resolved, agentIds])

  const rows = useMemo(() => {
    if (!resolved || !SETTINGS_ROWS_CATEGORIES.has(category)) return []
    if (searchQuery) {
      return settingFields(agentIds).filter(
        (r) =>
          r.cat === category &&
          (r.label.toLowerCase().includes(searchQuery) ||
            r.hint.toLowerCase().includes(searchQuery))
      )
    }
    return settingFields(agentIds).filter((r) => r.cat === category)
  }, [resolved, category, searchQuery, agentIds])

  const showScope = SETTINGS_SCOPE_CATEGORIES.has(category)
  const rowsTitle =
    category === 'composer'
      ? 'Sampling'
      : category === 'agent'
        ? 'Agent preferences'
        : category === 'logging'
          ? 'Log preferences'
          : category === 'general'
            ? 'Preferences'
            : 'Preferences'

  if (!open) return null

  if (!resolved || !layered) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className="modal settings-modal-loading"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          tabIndex={-1}
          style={{ gridTemplateColumns: '1fr', height: 'auto', minHeight: 160 }}
          onClick={(e) => e.stopPropagation()}
        >
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
      <div
        className="modal settings-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="modal-nav" aria-label="Settings sections">
          <div className="modal-nav-brand">SETTINGS</div>
          {SETTINGS_NAV.map((group, index) => {
            const expanded = expandedGroup === group.label
            const containsCurrent = group.items.includes(category)
            const groupId = `${navId}-group-${index}`
            return (
              <div key={group.label} className="modal-nav-group">
                <button
                  type="button"
                  className="modal-nav-group-toggle"
                  data-current={containsCurrent}
                  aria-expanded={expanded}
                  aria-controls={groupId}
                  onClick={() => setExpandedGroup(expanded ? null : group.label)}
                >
                  {group.label}
                  <span className="modal-nav-chevron" aria-hidden="true" />
                </button>
                <div id={groupId} className="modal-nav-group-items" hidden={!expanded}>
                  {group.items.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={category === id ? 'active' : ''}
                      aria-current={category === id ? 'page' : undefined}
                      onClick={() => selectCategory(id)}
                    >
                      {SETTINGS_LABELS[id]}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          <div style={{ flex: 1 }} />
          <button type="button" className="modal-nav-close" onClick={onClose}>
            Close
          </button>
        </nav>
        <div className="modal-content">
          <header className="settings-page-header">
            <div>
              <h2>{SETTINGS_LABELS[category]}</h2>
              <p className="subtitle">{SETTINGS_SUBTITLES[category]}</p>
            </div>
            <div className="settings-page-tools">
              <input
                placeholder="Search all settings…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search all settings"
              />
              {showScope && (
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
              )}
            </div>
          </header>

          {searchQuery && (pageHits.length > 0 || fieldHits.length > 0) && (
            <div className="settings-search-results">
              {pageHits.length > 0 && (
                <div className="settings-search-group">
                  <div className="settings-search-label">Pages</div>
                  {pageHits.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`settings-search-hit${id === category ? ' is-active' : ''}`}
                      onClick={() => selectCategory(id)}
                    >
                      <strong>{SETTINGS_LABELS[id]}</strong>
                      <span>{SETTINGS_SUBTITLES[id]}</span>
                    </button>
                  ))}
                </div>
              )}
              {fieldHits.length > 0 && (
                <div className="settings-search-group">
                  <div className="settings-search-label">Preferences</div>
                  {fieldHits.slice(0, 12).map((r) => (
                    <button
                      key={r.path.join('.')}
                      type="button"
                      className="settings-search-hit"
                      onClick={() => selectCategory(r.cat)}
                    >
                      <strong>{r.label}</strong>
                      <span>
                        {SETTINGS_LABELS[r.cat]} · {r.hint}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {category === 'usage' && <UsagePanel />}
          {category === 'memory' && (
            <MemoryPanel
              activeThreadId={activeThreadId}
              onChanged={async (next) => {
                onChanged(next)
                await load()
              }}
            />
          )}

          {category === 'composer' && (
            <ComposerModelsPanel
              resolved={resolved}
              status={status}
              apply={apply}
            />
          )}

          {category === 'gpu' && (
            <GpuModelsPanel resolved={resolved} status={status} apply={apply} load={load} />
          )}

          {category === 'textModels' && (
            <TextModelsPanel resolved={resolved} status={status} apply={apply} load={load} />
          )}

          {category === 'imageModels' && <ImageModelsPanel resolved={resolved} apply={apply} />}

          {category === 'cloudModels' && (
            <ErisCloudPanel
              resolved={resolved}
              status={status}
              onOpenAccount={() => selectCategory('account')}
              onSaveConnections={connections => apply(['models', 'connections'], connections)}
              onSetDefaultModel={model => apply(['models', 'defaultModel'], model)}
              onRefresh={async () => setStatus(await window.ide.modelsStatus({ probe: true, includeGpu: true }))}
            />
          )}

          {category === 'providers' && (
            <ProvidersModelsPanel resolved={resolved} status={status} apply={apply} load={load} />
          )}

          {category === 'agent' && <AgentPanel />}

          {category === 'workspace' && <WorkspacePanel hasWorkspace={hasWorkspace} />}

          {category === 'context' && (
            <ContextPanel state={contextState} hasWorkspace={hasWorkspace} />
          )}

          {category === 'rules' && <RulesPanel state={rulesState} hasWorkspace={hasWorkspace} />}

          {category === 'mcp' && (
            <McpPanel
              state={mcpState}
              resolved={resolved}
              hasWorkspace={hasWorkspace}
              scope={scope}
              setScope={setScope}
              apply={apply}
            />
          )}

          {category === 'github' && (
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

          {category === 'account' && (
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
              resolved={resolved}
              apply={apply}
              onClose={onClose}
              onRerunSetup={onRerunSetup}
            />
          )}

          {category === 'logging' && (
            <LoggingPanel state={logsState} resolved={resolved} apply={apply} />
          )}

          {category === 'feedback' && <FeedbackPanel />}

          {rows.length > 0 && (
            <SettingsSection
              title={rowsTitle}
              description={
                scope === 'workspace'
                  ? 'Changes write to .eris/settings.json for this project.'
                  : 'Changes apply to your user profile on this machine.'
              }
            >
              <SettingRows
                rows={rows}
                resolved={resolved}
                layered={layered}
                apply={apply}
                onChanged={onChanged}
                onReload={load}
              />
            </SettingsSection>
          )}
        </div>
      </div>
    </div>
  )
}
