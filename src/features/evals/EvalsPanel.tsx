import { useCallback, useEffect, useState } from 'react'
import type { EvalProgressEvent, EvalScoreboard, EvalTaskInfo } from '@/shared/evals'

interface Props {
  open: boolean
  models: string[]
  defaultModel: string
  onClose: () => void
}

export function EvalsPanel({ open, models, defaultModel, onClose }: Props) {
  const [tasks, setTasks] = useState<EvalTaskInfo[]>([])
  const [board, setBoard] = useState<EvalScoreboard | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [model, setModel] = useState(defaultModel)
  const [repeats, setRepeats] = useState(1)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [list, scores, active] = await Promise.all([
      window.ide.listEvalTasks(),
      window.ide.getEvalScoreboard(),
      window.ide.evalsRunning()
    ])
    setTasks(list)
    setBoard(scores)
    setRunning(active)
    setSelected((prev) => (prev.length ? prev.filter((id) => list.some((t) => t.id === id)) : list.map((t) => t.id)))
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    return window.ide.onEvalProgress((evt: EvalProgressEvent) => {
      if (evt.type === 'start') {
        setRunning(true)
        setStatus(`Running ${evt.total} jobs…`)
      } else if (evt.type === 'task-start') {
        setStatus(`${evt.taskId} · ${evt.model}`)
      } else if (evt.type === 'task-status') {
        setStatus(`${evt.taskId}: ${evt.text}`)
      } else if (evt.type === 'result') {
        setStatus(`${evt.result.taskId} ${evt.result.ok ? 'passed' : 'failed'}`)
      } else if (evt.type === 'done') {
        setRunning(false)
        setStatus(`${evt.passed}/${evt.total} passed${evt.cancelled ? ' (cancelled)' : ''}`)
        void refresh()
      }
    })
  }, [open, refresh])

  useEffect(() => {
    if (defaultModel) setModel(defaultModel)
  }, [defaultModel])

  if (!open) return null

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="git-panel">
      <div className="terminal-bar">
        <strong>Evals</strong>
        <span className="thinking-status-inline">{running ? status || 'running' : 'idle'}</span>
        <div className="diff-actions">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Editor
          </button>
        </div>
      </div>
      {error && <div className="git-error">{error}</div>}
      <div className="debug-toolbar">
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {(models.includes(model) ? models : [model, ...models]).filter(Boolean).map((m) => (
            <option key={m} value={m}>
              {m.replace(/^builtin:/, '')}
            </option>
          ))}
        </select>
        <label className="thinking-status-inline">
          repeats
          <input
            type="number"
            min={1}
            max={5}
            value={repeats}
            onChange={(e) => setRepeats(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
            style={{ width: 48, marginLeft: 6 }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || selected.length === 0 || !model}
          onClick={() => {
            setError(null)
            setRunning(true)
            void window.ide
              .runEvals({ taskIds: selected, models: [model], repeats })
              .then(() => refresh())
              .catch((err) => {
                setError(err instanceof Error ? err.message : 'Eval run failed')
                setRunning(false)
              })
          }}
        >
          Run suite
        </button>
        <button
          type="button"
          className="btn"
          disabled={!running}
          onClick={() => void window.ide.cancelEvals()}
        >
          Stop
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.ide.clearEvalResults().then((next) => {
              setBoard(next)
            })
          }
        >
          Clear scores
        </button>
      </div>
      <div className="git-body">
        <div className="git-files">
          <div className="explorer-section-label">Tasks</div>
          {tasks.map((t) => (
            <label key={t.id} className="git-file" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                onChange={() => toggle(t.id)}
              />
              <span>
                {t.title}
                <div className="hint">
                  {t.intent} · {t.source} · {t.checks} checks
                </div>
              </span>
            </label>
          ))}
        </div>
        <pre className="git-diff">
          {board && board.scores.length > 0
            ? board.scores
                .map(
                  (s) =>
                    `${s.model.replace(/^builtin:/, '')} · ${s.intent}  ${Math.round(s.successRate * 100)}%  (${s.passed}/${s.runs})  avg ${s.avgSteps.toFixed(1)} steps`
                )
                .join('\n')
            : 'No scores yet. Run the suite to measure a model.'}
          {board && board.recent.length > 0
            ? `\n\nRecent\n${board.recent
                .slice(0, 12)
                .map((r) => `${r.ok ? 'ok' : 'fail'}  ${r.taskId}  ${r.model.replace(/^builtin:/, '')}${r.error ? `  ${r.error}` : ''}`)
                .join('\n')}`
            : ''}
        </pre>
      </div>
      <div className="debug-hint">
        Add project tasks in <code>.eris/evals.json</code>. Routing uses these scores when enough
        runs exist for an intent.
      </div>
    </div>
  )
}
