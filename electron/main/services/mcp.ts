import type { AppSettings, McpServerConfig } from '../../../src/shared/settings-schema'

export function listEnabledMcpServers(settings: AppSettings): McpServerConfig[] {
  return (settings.mcp?.servers ?? []).filter((s) => s.enabled)
}

/** Short description injected into agent system prompts. */
export function formatMcpServersPrompt(settings: AppSettings): string {
  const enabled = listEnabledMcpServers(settings)
  if (enabled.length === 0) return ''
  const lines = enabled.map((s) => {
    const endpoint =
      s.transport === 'stdio'
        ? `stdio: ${[s.command, ...(s.args || [])].filter(Boolean).join(' ')}`
        : `${s.transport}: ${s.url || '(no url)'}`
    return `- ${s.name} (${s.id}) — ${endpoint}`
  })
  return [
    'Configured MCP servers (enabled in Settings → MCP):',
    ...lines,
    'These servers are registered for this workspace session. Prefer native Eris tools for file edits; use MCP when the user asks for those integrations.'
  ].join('\n')
}

export function validateMcpServer(server: Partial<McpServerConfig>): string | null {
  if (!server.name?.trim()) return 'Name is required'
  if (!server.transport) return 'Transport is required'
  if (server.transport === 'stdio') {
    if (!server.command?.trim()) return 'Command is required for stdio transport'
  } else if (!server.url?.trim()) {
    return 'URL is required for SSE/HTTP transport'
  }
  return null
}
