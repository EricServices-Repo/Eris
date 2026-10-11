import type { AppSettings, SettingsPatch } from '@/shared/settings-schema'
import type { LayeredSettings } from '@/shared/api'

export type Category =
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

export type ApplySetting = (path: string[], value: unknown) => Promise<void>

export interface SettingField {
  cat: Category
  label: string
  hint: string
  path: string[]
  type: 'boolean' | 'string' | 'number' | 'textarea' | 'select'
  options?: string[]
}

export function getAt(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export function setAt(path: string[], value: unknown): SettingsPatch {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let i = 0; i < path.length - 1; i++) {
    cursor[path[i]] = {}
    cursor = cursor[path[i]] as Record<string, unknown>
  }
  cursor[path[path.length - 1]] = value
  return root as SettingsPatch
}

export function settingFields(agentIds: string[]): SettingField[] {
  return [
    {
      cat: 'general',
      label: 'Restore last workspace',
      hint: 'Reopen the previous folder on launch',
      path: ['general', 'restoreLastWorkspace'],
      type: 'boolean'
    },
    {
      cat: 'general',
      label: 'Enable file logging',
      hint: 'Write app events to a daily log file',
      path: ['general', 'logging', 'enabled'],
      type: 'boolean'
    },
    {
      cat: 'general',
      label: 'Log level',
      hint: 'Minimum severity written to disk',
      path: ['general', 'logging', 'level'],
      type: 'select',
      options: ['debug', 'info', 'warn', 'error']
    },
    {
      cat: 'models',
      label: 'Default model',
      hint: 'builtin:composer-lite (~1 GB) or builtin:composer (~4.7 GB)',
      path: ['models', 'defaultModel'],
      type: 'string'
    },
    {
      cat: 'models',
      label: 'Temperature',
      hint: 'Default sampling temperature for agents without an override',
      path: ['models', 'temperature'],
      type: 'number'
    },
    {
      cat: 'models',
      label: 'Context window',
      hint: 'Tokens available to the model',
      path: ['models', 'contextWindow'],
      type: 'number'
    },
    {
      cat: 'agent',
      label: 'Shared system prompt',
      hint: 'Prefixed for every agent before its own prompt',
      path: ['agent', 'systemPrompt'],
      type: 'textarea'
    },
    {
      cat: 'agent',
      label: 'Include open files',
      hint: 'Attach active editor content to chat context',
      path: ['agent', 'includeOpenFiles'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Always keep all changes',
      hint: 'Skip review — keep every agent edit as it lands (user setting)',
      path: ['agent', 'autoKeepDiffs'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Command approval',
      hint: 'ask = confirm agent shell commands and pushes (read-only/test commands run freely); auto = never ask',
      path: ['agent', 'commandApproval'],
      type: 'select',
      options: ['ask', 'auto']
    },
    {
      cat: 'agent',
      label: 'Max history messages',
      hint: 'Trim older turns from context',
      path: ['agent', 'maxHistoryMessages'],
      type: 'number'
    },
    {
      cat: 'agent',
      label: 'Enable routing',
      hint: 'Route messages to the orchestrator or a specialist',
      path: ['agent', 'routing', 'enabled'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Routing mode',
      hint: 'auto picks an agent; manual uses the composer picker',
      path: ['agent', 'routing', 'mode'],
      type: 'select',
      options: ['auto', 'manual', 'off']
    },
    {
      cat: 'agent',
      label: 'Fallback agent',
      hint: 'Used when routing is off or no keywords match',
      path: ['agent', 'routing', 'fallbackAgentId'],
      type: 'select',
      options: agentIds
    },
    {
      cat: 'agent',
      label: 'Use LLM router',
      hint: 'Ask routerModel to classify intent + agent (falls back to heuristics)',
      path: ['agent', 'routing', 'useLlmRouter'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Router model',
      hint: 'Empty = default model. Prefer a small/fast Ollama model.',
      path: ['agent', 'routing', 'routerModel'],
      type: 'string'
    },
    {
      cat: 'editor',
      label: 'Font size',
      path: ['editor', 'fontSize'],
      type: 'number',
      hint: 'Editor font size in pixels'
    },
    {
      cat: 'editor',
      label: 'Tab size',
      path: ['editor', 'tabSize'],
      type: 'number',
      hint: 'Spaces per tab'
    },
    {
      cat: 'editor',
      label: 'Theme',
      path: ['editor', 'theme'],
      type: 'select',
      options: ['vs-dark', 'vs', 'hc-black'],
      hint: 'Monaco color theme'
    },
    {
      cat: 'editor',
      label: 'Inline suggestions',
      path: ['editor', 'inlineSuggest'],
      type: 'boolean',
      hint: 'As-you-type ghost completions (⌥\\ still forces one)'
    }
  ]
}

export function SettingRows({
  rows,
  resolved,
  layered,
  apply,
  onChanged,
  onReload
}: {
  rows: SettingField[]
  resolved: AppSettings
  layered: LayeredSettings
  apply: ApplySetting
  onChanged: (resolved: AppSettings) => void
  onReload: () => Promise<void>
}) {
  return (
    <>
      {rows.map((row) => {
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
                    await onReload()
                  })
              }
            >
              Reset
            </button>
          </div>
        )
      })}
    </>
  )
}
