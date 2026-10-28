import type { IdeApi } from '@/shared/api'
import { NODE_DEBUG_CAPABILITIES } from '@/shared/ide-capabilities'
import { useCallback, useEffect, useState } from 'react'

type LaunchConfig = {
  id: string
  name: string
  type: string
  request: string
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  runtimeArgs?: string[]
}

type Breakpoint = {
  id: string
  path: string
  line: number
  enabled: boolean
}

type DebugState = {
  running: boolean
  paused: boolean
  configId: string | null
  program: string | null
  port: number | null
  output: string
  reason?: string
  callFrames?: Array<{ functionName: string; url: string; lineNumber: number }>
}

interface Props {
  open: boolean
  workspacePath: string | null
  activeFile: string | null
  onClose: () => void
  onOpenPath: (path: string, line?: number) => void
}

export function DebugPanel({ open, workspacePath, activeFile, onClose, onOpenPath }: Props) {
  const [configs, setConfigs] = useState<LaunchConfig[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [bps, setBps] = useState<Breakpoint[]>([])
  const [state, setState] = useState<DebugState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [caps, setCaps] = useState<Awaited<ReturnType<IdeApi['debugCapabilities']>> | null>(null)
  const [variables, setVariables] = useState<Array<{ name: string; value: string }>>([])
  const [watch, setWatch] = useState('')
  const [watchResult, setWatchResult] = useState('')
  const [filters, setFilters] = useState<string[]>([])

  const refresh = useCallback(async () => {
    if (!workspacePath) return
    const [cfgs, breakpoints, st, capabilities] = await Promise.all([
      window.ide.debugListConfigs(),
      window.ide.debugListBreakpoints(),
      window.ide.debugState(),
      window.ide.debugCapabilities()
    ])
    setCaps(capabilities)
    setConfigs(cfgs)
    setBps(breakpoints)
    setState(st)
    if (!selectedId && cfgs[0]) setSelectedId(cfgs[0].id)
  }, [workspacePath, selectedId])

  useEffect(() => {
    if (open) void refresh().catch((e) => setError(String(e)))
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    return window.ide.onDebugState((s) => setState(s))
  }, [open])

  if (!open) return null

  const selected = configs.find((c) => c.id === selectedId) || configs[0]

  const supported =
    (selected?.type === 'node' && selected.request === 'launch') ||
    (['launch', 'attach'].includes(selected?.request ?? '') &&
      !!caps?.configured.some((a) => a.adapter === selected?.type))
  const dapActive = !!caps?.active && state?.running
  const exceptionFilters = (
    Array.isArray(caps?.active?.capabilities.exceptionBreakpointFilters)
      ? caps?.active?.capabilities.exceptionBreakpointFilters
      : []
  ) as Array<{ filter: string; label: string }>
  return (
    <div className="git-panel">
      <div className="terminal-bar">
        <strong>Run &amp; Debug</strong>
        <span className="thinking-status-inline">
          {state?.running ? (state.paused ? 'paused' : 'running') : 'idle'}
          {state?.port ? ` · :${state.port}` : ''}
        </span>
        <div className="diff-actions">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Editor
          </button>
        </div>
      </div>
      <p className="subtitle">{NODE_DEBUG_CAPABILITIES.reason}</p>
      {selected && !supported && (
        <p role="status">
          Unsupported target: {selected.type}/{selected.request}. Choose a supported Node launch
          configuration.
        </p>
      )}
      {error && <div className="git-error">{error}</div>}
      <div className="debug-toolbar">
        <select
          value={selected?.id || ''}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={!configs.length}
        >
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !selected || !supported || state?.running}
          onClick={() =>
            void (async () => {
              if (!selected) return
              setBusy(true)
              setError(null)
              try {
                await window.ide.debugStart(selected.id, activeFile)
                await refresh()
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Start failed')
              } finally {
                setBusy(false)
              }
            })()
          }
        >
          Start
        </button>
        <button
          type="button"
          className="btn"
          disabled={!state?.running}
          onClick={() => void window.ide.debugStop().then(() => refresh())}
        >
          Stop
        </button>
        <button
          type="button"
          className="btn"
          disabled={!state?.paused}
          onClick={() => void window.ide.debugContinue()}
        >
          Continue
        </button>
        <button
          type="button"
          className="btn"
          disabled={!state?.paused}
          onClick={() => void window.ide.debugStepOver()}
        >
          Step
        </button>
      </div>
      <section aria-label="Debugger adapter capabilities">
        <p className="subtitle">
          Optional DAP adapters must be installed and explicitly configured in user settings. Stdio
          only; attach uses loopback, and reverse process/network requests are refused.
        </p>
        <button
          type="button"
          className="btn"
          disabled={!dapActive || !state?.paused}
          onClick={() =>
            void window.ide
              .debugVariables()
              .then(setVariables)
              .catch((e) => setError(String(e)))
          }
        >
          Inspect variables
        </button>
        {variables.map((v, i) => (
          <p key={i}>
            <code>{v.name}</code>: {v.value}
          </p>
        ))}
        <input
          aria-label="Watch expression"
          value={watch}
          maxLength={2000}
          onChange={(e) => setWatch(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          title="Evaluation may execute code in the paused debuggee"
          disabled={!dapActive || !state?.paused || !watch.trim()}
          onClick={() =>
            void window.ide
              .debugEvaluate(watch)
              .then(setWatchResult)
              .catch((e) => setError(String(e)))
          }
        >
          Evaluate watch
        </button>
        {watchResult && <pre>{watchResult}</pre>}
        {exceptionFilters.map((f) => (
          <label key={f.filter}>
            <input
              type="checkbox"
              checked={filters.includes(f.filter)}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...filters, f.filter]
                  : filters.filter((x) => x !== f.filter)
                void window.ide
                  .debugExceptions(next)
                  .then(() => setFilters(next))
                  .catch((error) => setError(String(error)))
              }}
            />
            {f.label || f.filter}
          </label>
        ))}
      </section>
      <div className="git-body">
        <div className="git-files">
          <div className="explorer-section-label">Breakpoints</div>
          {bps.length === 0 ? (
            <div className="chat-empty">Click a gutter in the editor to add breakpoints.</div>
          ) : (
            bps.map((b) => (
              <button
                key={b.id}
                type="button"
                className="git-file"
                onClick={() => onOpenPath(b.path, b.line)}
              >
                <span className="diff-op">{b.enabled ? '●' : '○'}</span>
                <span>
                  {b.path}:{b.line}
                </span>
              </button>
            ))
          )}
          {state?.callFrames && state.callFrames.length > 0 && (
            <>
              <div className="explorer-section-label" style={{ marginTop: 10 }}>
                Call stack
              </div>
              {state.callFrames.map((f, i) => (
                <div key={i} className="git-file" style={{ cursor: 'default' }}>
                  <span className="diff-op">{i}</span>
                  <span>
                    {f.functionName}:{f.lineNumber}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        <pre className="git-diff">{state?.output || 'Debug output will appear here.'}</pre>
      </div>
      <div className="debug-hint">
        Configs live in <code>.eris/launch.json</code>. Program can be <code>${'{file}'}</code> for
        the active editor file.
      </div>
    </div>
  )
}
