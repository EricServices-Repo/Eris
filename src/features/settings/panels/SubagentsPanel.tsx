import type { AppSettings, ModelsStatus, ProjectAgentsConfig } from '@/shared/settings-schema'
import { AgentEditor } from './AgentEditor'

export function SubagentsPanel({
  hasWorkspace,
  resolved,
  status,
  projectAgents,
  setProjectAgents,
  agentsDirty,
  setAgentsDirty,
  agentsError,
  setAgentsError,
  onChanged
}: {
  hasWorkspace: boolean
  resolved: AppSettings
  status: ModelsStatus | null
  projectAgents: ProjectAgentsConfig | null
  setProjectAgents: (config: ProjectAgentsConfig | null) => void
  agentsDirty: boolean
  setAgentsDirty: (dirty: boolean) => void
  agentsError: string | null
  setAgentsError: (error: string | null) => void
  onChanged: (resolved: AppSettings) => void
}) {
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

  return (
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
  )
}
