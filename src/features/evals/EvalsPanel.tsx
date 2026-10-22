import { useCallback, useEffect, useState } from 'react'
import {
  CORPUS_RUN_COVERAGE,
  type CorpusDebugProgressEvent,
  type CorpusDebugRunSummary,
  type EvalProgressEvent,
  type EvalScoreboard,
  type EvalTaskInfo,
  type RejectedEvalTask
} from '@/shared/evals'
import { DiagnosticsSection } from './DiagnosticsSection'

interface Props {
  open: boolean
  models: string[]
  defaultModel: string
  onClose: () => void
}

export function EvalsPanel({ open, models, defaultModel, onClose }: Props) {
  const [tasks, setTasks] = useState<EvalTaskInfo[]>([])
  const [rejected, setRejected] = useState<RejectedEvalTask[]>([])
  const [board, setBoard] = useState<EvalScoreboard | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [model, setModel] = useState(defaultModel)
  const [repeats, setRepeats] = useState(1)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [corpusRuns, setCorpusRuns] = useState<CorpusDebugRunSummary[]>([])
  const [corpusRunning, setCorpusRunning] = useState(false)
  const [corpusStatus, setCorpusStatus] = useState('')
  const [corpusStart, setCorpusStart] = useState(1)
  const [corpusCount, setCorpusCount] = useState(25)
  const [corpusChunkSize, setCorpusChunkSize] = useState(10)
  const [corpusMaxSteps, setCorpusMaxSteps] = useState(20)

  const refresh = useCallback(async () => {
    const [list, scores, active, debugRuns, debugActive, invalid] = await Promise.all([
      window.ide.listEvalTasks(),
      window.ide.getEvalScoreboard(),
      window.ide.evalsRunning(),
      window.ide.listCorpusDebugRuns(),
      window.ide.corpusDebugRunning(),
      window.ide.listRejectedEvalTasks()
    ])
    setTasks(list)
    setRejected(invalid)
    setBoard(scores)
    setRunning(active)
    setCorpusRuns(debugRuns)
    setCorpusRunning(debugActive)
    setSelected((prev) =>
      prev.length
        ? prev.filter((id) => list.some((task) => task.id === id))
        : list.map((task) => task.id)
    )
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    return window.ide.onEvalProgress((evt: EvalProgressEvent) => {
      if (evt.type === 'start') {
        setRunning(true)
        setStatus(`Running ${evt.total} jobs…`)
      } else if (evt.type === 'task-start') setStatus(`${evt.taskId} · ${evt.model}`)
      else if (evt.type === 'task-status') setStatus(`${evt.taskId}: ${evt.text}`)
      else if (evt.type === 'result')
        setStatus(`${evt.result.taskId} ${evt.result.ok ? 'passed' : 'failed'}`)
      else if (evt.type === 'done') {
        setRunning(false)
        setStatus(`${evt.passed}/${evt.total} passed${evt.cancelled ? ' (cancelled)' : ''}`)
        void refresh()
      }
    })
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    return window.ide.onCorpusDebugProgress((evt: CorpusDebugProgressEvent) => {
      if (evt.type === 'start') {
        setCorpusRunning(true)
        setCorpusStatus(`Starting at question ${evt.summary.startIndex + 1}…`)
      } else if (evt.type === 'question-start') {
        setCorpusStatus(`Question ${evt.index + 1}/10,000 · ${evt.question.slice(0, 90)}`)
      } else if (evt.type === 'status') {
        setCorpusStatus(`Question ${evt.index + 1}: ${evt.text}`)
      } else if (evt.type === 'result') {
        setCorpusStatus(
          `${evt.summary.passed}/${evt.summary.completed} passed · next ${evt.summary.nextIndex + 1}`
        )
      } else if (evt.type === 'chunk-saved') {
        setCorpusStatus(`Saved checkpoint through question ${evt.summary.nextIndex}`)
      } else if (evt.type === 'done') {
        setCorpusRunning(false)
        setCorpusStatus(
          `${evt.summary.status}: ${evt.summary.passed}/${evt.summary.completed} passed`
        )
        setCorpusStart(Math.min(10_000, evt.summary.nextIndex + 1))
        void refresh()
      }
    })
  }, [open, refresh])

  useEffect(() => {
    if (defaultModel) setModel(defaultModel)
  }, [defaultModel])

  if (!open) return null
  const latestCorpus = corpusRuns[0]
  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  return (
    <div className="git-panel">
      <div className="terminal-bar">
        <strong>Evals</strong>
        <span className="thinking-status-inline">
          {corpusRunning
            ? corpusStatus || 'running model corpus'
            : running
              ? status || 'running'
              : 'idle'}
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
      {error && <div className="git-error">{error}</div>}
      <DiagnosticsSection
        models={models}
        defaultModel={defaultModel}
        busy={running || corpusRunning}
      />
      <section className="eval-corpus-card">
        <div className="eval-corpus-heading">
          <div>
            <strong>10,000-question real-model corpus run</strong>
            <div className="hint">
              {CORPUS_RUN_COVERAGE.path} {CORPUS_RUN_COVERAGE.oracle} Each chunk saves raw JSONL and
              a Markdown report for review.
            </div>
          </div>
          <span className="thinking-status-inline">{corpusStatus || 'not running'}</span>
        </div>
        <div className="debug-toolbar eval-corpus-toolbar">
          <label>
            Start
            <input
              type="number"
              min={1}
              max={10_000}
              value={corpusStart}
              onChange={(event) =>
                setCorpusStart(Math.max(1, Math.min(10_000, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label>
            Questions
            <input
              type="number"
              min={1}
              max={10_000}
              value={corpusCount}
              onChange={(event) =>
                setCorpusCount(Math.max(1, Math.min(10_000, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label>
            Save every
            <input
              type="number"
              min={1}
              max={100}
              value={corpusChunkSize}
              onChange={(event) =>
                setCorpusChunkSize(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
              }
            />
          </label>
          <label>
            Step cap
            <input
              type="number"
              min={10}
              max={200}
              value={corpusMaxSteps}
              onChange={(event) =>
                setCorpusMaxSteps(Math.max(10, Math.min(200, Number(event.target.value) || 10)))
              }
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running || corpusRunning || !model}
            onClick={() => {
              setError(null)
              setCorpusRunning(true)
              void window.ide
                .runCorpusDebug({
                  model,
                  startIndex: corpusStart - 1,
                  count: corpusCount,
                  chunkSize: corpusChunkSize,
                  maxSteps: corpusMaxSteps
                })
                .catch((err) => {
                  setError(err instanceof Error ? err.message : 'Corpus run failed')
                  setCorpusRunning(false)
                })
            }}
          >
            Run model chunk
          </button>
          <button
            type="button"
            className="btn"
            disabled={!corpusRunning}
            onClick={() => void window.ide.cancelCorpusDebug()}
          >
            Stop run
          </button>
          <button
            type="button"
            className="btn"
            disabled={!latestCorpus}
            onClick={() => latestCorpus && void window.ide.exportCorpusDebug(latestCorpus.runId)}
          >
            Export latest review
          </button>
          <button
            type="button"
            className="btn"
            disabled={!latestCorpus}
            onClick={() => void window.ide.openCorpusDebugFolder()}
          >
            Show saved files
          </button>
        </div>
        {latestCorpus && (
          <div className="eval-corpus-latest">
            Latest: {latestCorpus.status} · {latestCorpus.passed}/{latestCorpus.completed} passed ·
            questions {latestCorpus.startIndex + 1}–
            {Math.max(latestCorpus.startIndex + 1, latestCorpus.nextIndex)} · next{' '}
            {Math.min(10_000, latestCorpus.nextIndex + 1)}
          </div>
        )}
      </section>
      <div className="debug-toolbar">
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {(models.includes(model) ? models : [model, ...models]).filter(Boolean).map((item) => (
            <option key={item} value={item}>
              {item.replace(/^builtin:/, '')}
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
            onChange={(event) =>
              setRepeats(Math.max(1, Math.min(5, Number(event.target.value) || 1)))
            }
            style={{ width: 48, marginLeft: 6 }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || corpusRunning || selected.length === 0 || !model}
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
          onClick={() => void window.ide.clearEvalResults().then(setBoard)}
        >
          Clear scores
        </button>
      </div>
      <div className="git-body">
        <div className="git-files">
          <div className="explorer-section-label">Tasks</div>
          {rejected.map((item, index) => (
            <div key={`${item.file}-${item.id ?? index}`} className="git-error">
              Skipped {item.id ? `“${item.id}”` : 'a task'} in {item.file}: {item.error}
            </div>
          ))}
          {tasks.map((task) => (
            <label key={task.id} className="git-file" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.includes(task.id)}
                onChange={() => toggle(task.id)}
              />
              <span>
                {task.title}
                <div className="hint">
                  {task.intent} · {task.source} · {task.checks} checks
                </div>
              </span>
            </label>
          ))}
        </div>
        <pre className="git-diff">
          {board && board.scores.length > 0
            ? board.scores
                .map(
                  (score) =>
                    `${score.model.replace(/^builtin:/, '')} · ${score.intent}  ${Math.round(score.successRate * 100)}%  (${score.passed}/${score.runs})  avg ${score.avgSteps.toFixed(1)} steps`
                )
                .join('\n')
            : 'No scores yet. Run the suite to measure a model.'}
          {board && board.recent.length > 0
            ? `\n\nRecent\n${board.recent
                .slice(0, 12)
                .map(
                  (result) =>
                    `${result.ok ? 'ok' : 'fail'}  ${result.taskId}  ${result.model.replace(/^builtin:/, '')}${result.error ? `  ${result.error}` : ''}`
                )
                .join('\n')}`
            : ''}
        </pre>
      </div>
      <div className="debug-hint">
        Diagnostics simulations and the <code>npm run test:agents</code> prebuild gate use scripted
        model replies; neither is a real-model result, and the prebuild gate is not the full{' '}
        <code>npm run check</code> (typecheck, lint, every test). The corpus runner and the suite
        above make real model calls. Add project tasks in <code>.eris/evals.json</code>.
      </div>
    </div>
  )
}
