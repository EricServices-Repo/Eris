import { useDialogFocus } from '@/hooks/useDialogFocus'
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
import { mergeModelsDownloadStatus, upsertDownloadRow } from '@/shared/model-download-ui'
import { GitHubSettingsPanel } from './GitHubSettingsPanel'
import { EricServicesAccountPanel } from './EricServicesAccountPanel'
import { UsagePanel } from './UsagePanel'
import { type Category, SettingRows, setAt, settingFields } from './fields'
import { MemoryPanel } from './panels/MemoryPanel'
import { AgentPanel } from './panels/AgentPanel'
import { ContextPanel, useContextPanelState } from './panels/ContextPanel'
import { FeedbackPanel } from './panels/FeedbackPanel'
import { GeneralPanel } from './panels/GeneralPanel'
import { LoggingPanel, useLogsState } from './panels/LoggingPanel'
import { McpPanel, useMcpPanelState } from './panels/McpPanel'
import {
  ComposerModelsPanel,
  GpuModelsPanel,
  ImageModelsPanel,
  ProvidersModelsPanel,
  TextModelsPanel,
  useModelsPanelState
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
      setCategory('skills')
      void loadSkills(null, true)
      return
    }
    if (initialCategory) {
      const resolvedCat = resolveSettingsCategory(initialCategory) || 'composer'
      setCategory(resolvedCat)
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
    const offBuiltin = window.ide.onBuiltinDownloadProgress((s) => {
      setStatus((prev) => (prev ? { ...prev, builtin: upsertDownloadRow(prev.builtin, s) } : prev))
      if (s.downloading) modelsState.setDownloadingId(s.id)
      else if (s.ready || s.downloadError) {
        modelsState.setDownloadingId((cur) => (cur === s.id ? null : cur))
      }
    })
    const offLocal = window.ide.onLocalDownloadProgress((s) => {
      // Upsert: HF downloads register a new catalog id that may not be in the list yet.
      setStatus((prev) =>
        prev
          ? { ...prev, local: upsertDownloadRow(prev.local ?? [], s) }
          : {
              ok: true,
              builtin: [],
              local: [s],
              models: [],
              connections: []
            }
      )
      if (s.downloading) modelsState.setDownloadingId(s.id)
      else if (s.ready || s.downloadError) {
        modelsState.setDownloadingId((cur) => (cur === s.id ? null : cur))
      }
    })
    return () => {
      offBuiltin()
      offLocal()
    }
  }, [open])

  // Keep progress fresh when Settings was closed mid-download (main process owns the transfer).
  // Use light builtin/local snapshots — full modelsStatus() probes connections and arrives late,
  // which made the percentage jump backwards on Windows.
  useEffect(() => {
    if (!open || (category !== 'composer' && category !== 'textModels')) return
    const downloading =
      Boolean(modelsState.downloadingId) ||
      Boolean(status?.builtin?.some((b) => b.downloading)) ||
      Boolean(status?.local?.some((m) => m.downloading))
    if (!downloading) return
    const id = window.setInterval(() => {
      void Promise.all([window.ide.builtinModelStatus(), window.ide.localModelStatus()]).then(
        ([builtin, local]) => {
          setStatus((prev) => {
            const next = {
              ...(prev || {
                ok: true,
                builtin: [],
                local: [],
                models: [],
                connections: []
              }),
              builtin,
              local
            } as ModelsStatus
            return mergeModelsDownloadStatus(prev, next)
          })
          const still = builtin.find((b) => b.downloading) || local.find((m) => m.downloading)
          modelsState.setDownloadingId(still?.id ?? null)
        }
      )
    }, 1_500)
    return () => window.clearInterval(id)
  }, [open, category, modelsState.downloadingId])

  useEffect(() => {
    if (!hasWorkspace && scope === 'workspace') setScope('user')
  }, [hasWorkspace, scope])

  const resolved = layered?.resolved

  const apply = async (path: string[], value: unknown) => {
    const saveScope: SettingsScope =
      (path[0] === 'agent' && path[1] === 'autoKeepDiffs') || path[0] === 'ericServices'
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
        <div className="modal-nav">
          <div className="modal-nav-brand">SETTINGS</div>
          {SETTINGS_NAV.map((group) => (
            <div key={group.label} className="modal-nav-group">
              <div className="modal-nav-group-label">{group.label}</div>
              {group.items.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={category === id ? 'active' : ''}
                  onClick={() => setCategory(id)}
                >
                  {SETTINGS_LABELS[id]}
                </button>
              ))}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <button type="button" className="modal-nav-close" onClick={onClose}>
            Close
          </button>
        </div>
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
                      onClick={() => setCategory(id)}
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
                      onClick={() => setCategory(r.cat)}
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
              state={modelsState}
              resolved={resolved}
              status={status}
              apply={apply}
              load={load}
            />
          )}

          {category === 'gpu' && (
            <GpuModelsPanel resolved={resolved} status={status} apply={apply} load={load} />
          )}

          {category === 'textModels' && (
            <TextModelsPanel resolved={resolved} status={status} apply={apply} load={load} />
          )}

          {category === 'imageModels' && <ImageModelsPanel resolved={resolved} apply={apply} />}

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
