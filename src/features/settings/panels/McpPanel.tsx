import { useState } from 'react'
import type { AppSettings, McpServerConfig, SettingsScope } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'

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

export function useMcpPanelState() {
  const [mcpDraft, setMcpDraft] = useState<McpServerConfig | null>(null)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [mcpRuntime, setMcpRuntime] = useState<Awaited<
    ReturnType<typeof window.ide.mcpStatus>
  > | null>(null)
  return { mcpDraft, setMcpDraft, mcpError, setMcpError, mcpRuntime, setMcpRuntime }
}

export type McpPanelState = ReturnType<typeof useMcpPanelState>

export function McpPanel({
  state,
  resolved,
  hasWorkspace,
  scope,
  setScope,
  apply
}: {
  state: McpPanelState
  resolved: AppSettings
  hasWorkspace: boolean
  scope: SettingsScope
  setScope: (scope: SettingsScope) => void
  apply: ApplySetting
}) {
  const { mcpDraft, setMcpDraft, mcpError, setMcpError, mcpRuntime, setMcpRuntime } = state
  return (
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
  )
}
