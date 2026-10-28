import type { AppSettings, SettingsPatch } from '@/shared/settings-schema'
import type { LayeredSettings } from '@/shared/api'

export type Category =
  | 'general'
  | 'account'
  | 'gpu'
  | 'composer'
  | 'textModels'
  | 'imageModels'
  | 'providers'
  | 'usage'
  | 'agent'
  | 'subagents'
  | 'skills'
  | 'rules'
  | 'context'
  | 'mcp'
  | 'github'
  | 'feedback'
  | 'logging'
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
  /** Optional display labels for select option values. */
  optionLabels?: Record<string, string>
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
      cat: 'logging',
      label: 'Enable file logging',
      hint: 'Write app events to a daily log file',
      path: ['general', 'logging', 'enabled'],
      type: 'boolean'
    },
    {
      cat: 'logging',
      label: 'Log level',
      hint: 'Minimum severity written to disk',
      path: ['general', 'logging', 'level'],
      type: 'select',
      options: ['debug', 'info', 'warn', 'error']
    },
    {
      cat: 'composer',
      label: 'Temperature',
      hint: 'Default sampling temperature for agents without an override',
      path: ['models', 'temperature'],
      type: 'number'
    },
    {
      cat: 'composer',
      label: 'Context window',
      hint: 'Tokens available to the model',
      path: ['models', 'contextWindow'],
      type: 'number'
    },
    {
      cat: 'agent',
      label: 'Shared system prompt',
      hint: 'Prefixed for every agent before its own prompt — environment + universal rules',
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
      label: 'Project memory',
      hint: 'auto = write .eris/context.md after agent runs; ask = confirm in chat; off = never',
      path: ['agent', 'projectMemory'],
      type: 'select',
      options: ['auto', 'ask', 'off']
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
      label: 'Routing profile',
      hint: 'Auto = seamless Lite + Cloud; Local = never Cloud; Max = prefer Cloud Composer for agent work',
      path: ['agent', 'routing', 'profile'],
      type: 'select',
      options: ['auto', 'local', 'max']
    },
    {
      cat: 'agent',
      label: 'Prefer Cloud Composer',
      hint: 'When signed in, Agent mode may run built-in tools on Cloud (ignored when profile is Local)',
      path: ['agent', 'routing', 'preferCloudComposer'],
      type: 'boolean'
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
      hint: 'Ask routerModel to classify intent + agent (Auto/Max profiles enable this automatically)',
      path: ['agent', 'routing', 'useLlmRouter'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Max steps per run',
      hint: 'Stop an unproductive or oversized run while preserving its workspace checkpoint; 10–200 tool/model rounds',
      path: ['agent', 'maxStepsPerRun'],
      type: 'number'
    },
    {
      cat: 'agent',
      label: 'Router model',
      hint: 'Empty = default model. Prefer a small/fast Ollama model.',
      path: ['agent', 'routing', 'routerModel'],
      type: 'string'
    },
    {
      cat: 'agent',
      label: 'Route from eval scores',
      hint: 'Prefer the model with the best success rate for this intent',
      path: ['evals', 'useScoresForRouting'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Min eval runs',
      hint: 'Runs required per model × intent before scores change routing',
      path: ['evals', 'minRuns'],
      type: 'number'
    },
    {
      cat: 'agent',
      label: 'Evals may run unsafe commands',
      hint: 'Off = evals only auto-allow node/npm test commands',
      path: ['evals', 'allowUnsafeCommands'],
      type: 'boolean'
    },
    {
      cat: 'agent',
      label: 'Max parallel background agents',
      hint: 'Each job uses its own git worktree',
      path: ['backgroundAgents', 'maxParallel'],
      type: 'number'
    },
    {
      cat: 'agent',
      label: 'Link node_modules into worktrees',
      hint: 'Symlink the workspace install so background agents skip npm install',
      path: ['backgroundAgents', 'linkNodeModules'],
      type: 'boolean'
    },
    {
      cat: 'editor',
      label: 'Embedding provider',
      hint: 'External embedding utility only. Workspace retrieval stays local: path/symbol/lexical + hash128; not a learned semantic model.',
      path: ['intelligence', 'embeddingProvider'],
      type: 'select',
      options: ['auto', 'local', 'connection']
    },
    {
      cat: 'editor',
      label: 'Embedding model',
      hint: 'Optional external utility model. Changing it does not change the workspace index or enable remote transfer.',
      path: ['intelligence', 'embeddingModel'],
      type: 'string'
    },
    {
      cat: 'editor',
      label: 'Remote embedding transfer policy',
      hint: 'Disabled by default. Queries-only may send query text; workspace-content additionally permits source text. Current workspace indexing never transfers files.',
      path: ['intelligence', 'remoteEmbeddingPolicy'],
      type: 'select',
      options: ['disabled', 'queries-only', 'workspace-content']
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
      label: 'Chat response font',
      path: ['editor', 'chatFont'],
      type: 'select',
      options: ['sans', 'mono', 'serif'],
      optionLabels: {
        sans: 'Sans (UI)',
        mono: 'Monospace',
        serif: 'Serif'
      },
      hint: 'Font for assistant replies; code blocks stay monospace'
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
  if (rows.length === 0) return null

  return (
    <div className="settings-rows">
      {rows.map((row) => {
        const value = getAt(resolved, row.path)
        const overridden =
          getAt(layered.workspace, row.path) !== undefined
            ? 'workspace'
            : getAt(layered.user, row.path) !== undefined
              ? 'user'
              : 'default'
        return (
          <div className={`setting-row setting-row--${row.type}`} key={row.path.join('.')}>
            <div className="setting-row-copy">
              <label>{row.label}</label>
              <div className="hint">
                {row.hint} · <span className="badge">{overridden}</span>
              </div>
            </div>
            <div className="setting-row-control">
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
                      {row.optionLabels?.[o] ?? o}
                    </option>
                  ))}
                </select>
              )}
            </div>
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
    </div>
  )
}
