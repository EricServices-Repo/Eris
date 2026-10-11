export function WorkspacePanel({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <div className="subtitle">
      Workspace overrides: <code>.eris/settings.json</code>. Agents:{' '}
      <code>.eris/agents.json</code>. Context: <code>.eris/context.md</code>. Rules:{' '}
      <code>.eris/rules/*.md</code>. Skills: <code>.eris/skills/*/SKILL.md</code>.
      {!hasWorkspace && ' Open a folder to edit project-scoped files.'}
    </div>
  )
}
