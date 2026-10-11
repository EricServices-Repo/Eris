export function AgentPanel() {
  return (
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
  )
}
