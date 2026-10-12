import { SettingsPage, SettingsSection } from '../SettingsSection'

const PROJECT_FILES = [
  {
    title: 'Settings',
    path: '.eris/settings.json',
    hint: 'Workspace overrides for models, agent, and editor preferences'
  },
  {
    title: 'Agents',
    path: '.eris/agents.json',
    hint: 'Orchestrator and specialist subagents for this project'
  },
  {
    title: 'Context',
    path: '.eris/context.md',
    hint: 'Pinned summary and notes the agent sees every turn'
  },
  {
    title: 'Rules',
    path: '.eris/rules/*.md',
    hint: 'Always-on instructions (coding standards, product facts)'
  },
  {
    title: 'Skills',
    path: '.eris/skills/*/SKILL.md',
    hint: 'Optional workflows the agent can load on demand'
  }
] as const

export function WorkspacePanel({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <SettingsPage>
      <SettingsSection
        title="Project folder"
        description={
          hasWorkspace
            ? 'These files live in the linked workspace and override your user defaults when scope is Workspace.'
            : 'Open or link a folder to enable project-scoped settings and agent config.'
        }
      >
        {!hasWorkspace && (
          <p className="settings-empty">No workspace linked. Use File → Link Folder as Workspace…</p>
        )}
        <ul className="workspace-file-list">
          {PROJECT_FILES.map((f) => (
            <li key={f.path}>
              <div>
                <strong>{f.title}</strong>
                <span>{f.hint}</span>
              </div>
              <code>{f.path}</code>
            </li>
          ))}
        </ul>
      </SettingsSection>
    </SettingsPage>
  )
}
