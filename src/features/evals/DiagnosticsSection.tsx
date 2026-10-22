import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DebugCaseResult,
  DebugExportPreview,
  DebugRunDetail,
  DebugRunMode,
  DebugRunProgressEvent,
  DebugRunSummary,
  DebugScenarioInfo
} from '@/shared/debug-runs'

interface Props {
  models: string[]
  defaultModel: string
  /** Another eval/corpus run is active; diagnostics must wait. */
  busy: boolean
}

const STATUS_CLASS: Record<DebugCaseResult['status'], string> = {
  passed: 'is-pass',
  failed: 'is-fail',
  timed_out: 'is-fail',
  cancelled: 'is-muted',
  error: 'is-fail'
}

function verdictClass(summary: DebugRunSummary): string {
  if (summary.verdict === 'PASS') return 'is-pass'
  if (summary.verdict === 'FAIL') return 'is-fail'
  return 'is-muted'
}

function runOption(summary: DebugRunSummary): string {
  const when = new Date(summary.startedAt).toLocaleString()
  return `${summary.verdict ?? 'RUNNING'} · ${summary.label} · ${summary.passed}/${summary.planned} · ${when}`
}

/** Build & agent diagnostics: labeled simulated/real-model runs, case timelines, replay, export. */
export function DiagnosticsSection({ models, defaultModel, busy }: Props) {
  const [scenarios, setScenarios] = useState<DebugScenarioInfo[]>([])
  const [runs, setRuns] = useState<DebugRunSummary[]>([])
  const [mode, setMode] = useState<DebugRunMode>('simulated')
  const [model, setModel] = useState(defaultModel)
  const [captureResponses, setCaptureResponses] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DebugRunDetail | null>(null)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [includeResponses, setIncludeResponses] = useState(false)
  const [preview, setPreview] = useState<DebugExportPreview | null>(null)

  const available = useMemo(
    () => scenarios.filter((scenario) => scenario.modes.includes(mode)),
    [scenarios, mode]
  )

  const refresh = useCallback(async () => {
    const [list, history, active] = await Promise.all([
      window.ide.listDebugScenarios(),
      window.ide.listDebugRuns(),
      window.ide.debugRunActive()
    ])
    setScenarios(list)
    setRuns(history)
    setRunning(active)
    setRunId((current) => current ?? history[0]?.runId ?? null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (defaultModel) setModel(defaultModel)
  }, [defaultModel])

  useEffect(() => {
    setSelected(available.map((scenario) => scenario.id))
  }, [available])

  useEffect(() => {
    if (!runId) {
      setDetail(null)
      return
    }
    let stale = false
    void window.ide
      .getDebugRun(runId)
      .then((next) => {
        if (!stale) setDetail(next)
      })
      .catch(() => {
        if (!stale) setDetail(null)
      })
    return () => {
      stale = true
    }
  }, [runId, runs])

  useEffect(() => {
    setPreview(null)
  }, [runId, includeResponses])

  useEffect(
    () =>
      window.ide.onDebugRunEvent((event: DebugRunProgressEvent) => {
        if (event.type === 'start') {
          setRunning(true)
          setRunId(event.summary.runId)
          setStatus(`${event.summary.label} · starting ${event.summary.planned} cases`)
        } else if (event.type === 'case-start') {
          setStatus(`Case ${event.index + 1}: ${event.scenarioId}`)
        } else if (event.type === 'case-status') {
          setStatus(`Case ${event.index + 1}: ${event.text}`)
        } else if (event.type === 'case-result') {
          setStatus(
            `${event.summary.passed}/${event.summary.completed} passed · ${event.result.scenarioId} ${event.result.status}`
          )
          setRuns((prev) => [
            event.summary,
            ...prev.filter((run) => run.runId !== event.summary.runId)
          ])
        } else if (event.type === 'done') {
          setRunning(false)
          setStatus(`${event.summary.verdict} · ${event.summary.label}`)
          void refresh()
        }
      }),
    [refresh]
  )

  const start = () => {
    setError(null)
    if (mode === 'real-model') {
      const ok = window.confirm(
        `Run ${selected.length} curated diagnostics prompts against ${model.replace(/^builtin:/, '')}?\n\n` +
          'This makes real model calls. Only built-in prompts and a disposable fixture project are sent; ' +
          'your open project is never read or written. Commands, web, and MCP tools stay disabled.'
      )
      if (!ok) return
    }
    setRunning(true)
    const request =
      mode === 'simulated'
        ? { mode, scenarioIds: selected }
        : {
            mode,
            scenarioIds: selected,
            model,
            acknowledgeLiveCalls: true as const,
            captureResponses
          }
    void window.ide.startDebugRun(request).catch((err) => {
      setError(err instanceof Error ? err.message : 'Diagnostics run failed')
      setRunning(false)
    })
  }

  const replay = (caseIds?: string[]) => {
    if (!detail) return
    setError(null)
    setRunning(true)
    void window.ide
      .replayDebugRun({ runId: detail.summary.runId, ...(caseIds ? { caseIds } : {}) })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Replay failed')
        setRunning(false)
      })
  }

  const summary = detail?.summary
  const activeCase = detail?.cases.find((item) => item.caseId === caseId) ?? null
  const answer = activeCase
    ? detail?.responses.find((item) => item.caseId === activeCase.caseId && item.kind === 'answer')
    : undefined
  const canReplay = Boolean(detail?.responses.some((item) => item.kind === 'model'))

  return (
    <section className="eval-corpus-card diag-card">
      <div className="eval-corpus-heading">
        <div>
          <strong>Build &amp; agent diagnostics</strong>
          <div className="hint">
            Runs curated chat turns through the production route → task contract → agent → outcome
            pipeline in disposable fixture projects. Simulated runs use scripted model replies and
            make no model calls.
          </div>
        </div>
        <span className={`diag-badge ${mode === 'simulated' ? 'is-sim' : 'is-live'}`}>
          {mode === 'simulated' ? 'SIMULATED MODEL RESPONSES' : 'REAL MODEL'}
        </span>
      </div>
      <div className="debug-toolbar eval-corpus-toolbar">
        <label>
          <input
            type="radio"
            name="diag-mode"
            checked={mode === 'simulated'}
            disabled={running}
            onChange={() => setMode('simulated')}
          />
          Simulated
        </label>
        <label>
          <input
            type="radio"
            name="diag-mode"
            checked={mode === 'real-model'}
            disabled={running}
            onChange={() => setMode('real-model')}
          />
          Real model
        </label>
        {mode === 'real-model' && (
          <>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {(models.includes(model) ? models : [model, ...models])
                .filter(Boolean)
                .map((item) => (
                  <option key={item} value={item}>
                    {item.replace(/^builtin:/, '')}
                  </option>
                ))}
            </select>
            <label title="Stores raw model replies locally so the run can be replayed without new model calls.">
              <input
                type="checkbox"
                checked={captureResponses}
                onChange={(event) => setCaptureResponses(event.target.checked)}
              />
              Store replies for replay
            </label>
          </>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || busy || selected.length === 0 || (mode === 'real-model' && !model)}
          onClick={start}
        >
          {mode === 'simulated' ? 'Run simulation' : 'Run real-model smoke'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!running}
          onClick={() => void window.ide.cancelDebugRun()}
        >
          Stop
        </button>
        <span className="thinking-status-inline">{running ? status || 'running' : status}</span>
      </div>
      {error && <div className="git-error">{error}</div>}
      <div className="diag-scenarios">
        {available.map((scenario) => (
          <label key={scenario.id} title={scenario.description}>
            <input
              type="checkbox"
              checked={selected.includes(scenario.id)}
              disabled={running}
              onChange={() =>
                setSelected((prev) =>
                  prev.includes(scenario.id)
                    ? prev.filter((id) => id !== scenario.id)
                    : [...prev, scenario.id]
                )
              }
            />
            {scenario.title}
          </label>
        ))}
      </div>
      {runs.length > 0 && (
        <div className="debug-toolbar eval-corpus-toolbar">
          <select value={runId ?? ''} onChange={(event) => setRunId(event.target.value || null)}>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {runOption(run)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={running || busy || !canReplay}
            title={
              canReplay
                ? 'Re-run the stored model replies against current code. No model calls; no prior approvals are reused.'
                : 'This run did not store model replies.'
            }
            onClick={() => replay()}
          >
            Replay recorded responses
          </button>
          <label>
            <input
              type="checkbox"
              checked={includeResponses}
              onChange={(event) => setIncludeResponses(event.target.checked)}
            />
            Include model replies in export
          </label>
          <button
            type="button"
            className="btn"
            disabled={!summary}
            onClick={() =>
              summary &&
              void window.ide
                .previewDebugRunExport({ runId: summary.runId, includeResponses })
                .then(setPreview)
            }
          >
            Preview export
          </button>
          <button
            type="button"
            className="btn"
            disabled={!summary || summary.status === 'running'}
            onClick={() =>
              summary &&
              void window.ide
                .exportDebugRun({ runId: summary.runId, includeResponses })
                .then((saved) => saved && setStatus(`Exported ${saved.jsonPath}`))
                .catch((err) => setError(err instanceof Error ? err.message : 'Export failed'))
            }
          >
            Export…
          </button>
          <button
            type="button"
            className="btn"
            disabled={!summary || summary.status === 'running'}
            onClick={() => {
              if (!summary || !window.confirm('Delete this diagnostics run from this device?'))
                return
              void window.ide.deleteDebugRun(summary.runId).then(() => {
                setRunId(null)
                setCaseId(null)
                void refresh()
              })
            }}
          >
            Delete
          </button>
        </div>
      )}
      {preview && (
        <div className="eval-corpus-latest">
          Export preview · {preview.label} · {preview.cases} cases ·{' '}
          {(preview.bytes / 1024).toFixed(1)} KB
          <ul className="diag-list">
            {preview.contents.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {detail && summary && (
        <div className="diag-run">
          <div className="diag-run-head">
            <span
              className={`diag-badge ${summary.responseSource === 'live' ? 'is-live' : 'is-sim'}`}
            >
              {summary.label}
            </span>
            <span className={`diag-verdict ${verdictClass(summary)}`}>
              {summary.verdict ?? 'RUNNING'}
            </span>
            <span className="hint">
              {summary.passed} passed · {summary.failed} failed · {summary.timedOut} timed out ·{' '}
              {summary.cancelled} cancelled · {summary.errored} errors · {summary.completed}/
              {summary.planned} run · model {summary.model.ref.replace(/^builtin:/, '')}
              {summary.replayOf ? ` · replay of ${summary.replayOf}` : ''}
            </span>
          </div>
          <details className="diag-limits">
            <summary>What this run can and cannot establish</summary>
            <ul className="diag-list">
              {summary.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
          <table className="diag-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Scenario</th>
                <th>Status</th>
                <th>Expected → routed</th>
                <th>Failure</th>
                <th>Changed</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {detail.cases.map((item) => (
                <tr
                  key={item.caseId}
                  className={item.caseId === caseId ? 'is-active' : ''}
                  onClick={() => setCaseId(item.caseId === caseId ? null : item.caseId)}
                >
                  <td>{item.index + 1}</td>
                  <td>{item.scenarioTitle}</td>
                  <td className={STATUS_CLASS[item.status]}>{item.status.replace('_', ' ')}</td>
                  <td>
                    {(item.route?.expectedIntents.join('/') || '—') +
                      ' → ' +
                      (item.route ? `${item.route.intent} · ${item.route.agentId}` : '—')}
                  </td>
                  <td>{item.failure ? `${item.failure.stage} / ${item.failure.category}` : '—'}</td>
                  <td>{item.changedPaths.join(', ') || '—'}</td>
                  <td>{item.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {activeCase && (
            <div className="diag-case">
              <div className="diag-run-head">
                <strong>{activeCase.scenarioTitle}</strong>
                <span className="hint">
                  terminal {activeCase.terminal ?? 'none'} · {activeCase.steps} steps ·{' '}
                  {activeCase.toolCalls} tools ({activeCase.toolErrors} errors) ·{' '}
                  {activeCase.modelCalls.length} model calls ({activeCase.responseSource})
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={running || busy || !canReplay}
                  onClick={() => replay([activeCase.caseId])}
                >
                  Replay this case
                </button>
              </div>
              {activeCase.failure && (
                <div className="git-error">
                  {activeCase.failure.stage} / {activeCase.failure.category}:{' '}
                  {activeCase.failure.detail}
                </div>
              )}
              {activeCase.warnings.map((warning) => (
                <div key={warning} className="hint">
                  Warning: {warning}
                </div>
              ))}
              <ul className="diag-list">
                {activeCase.checks.map((check, index) => (
                  <li key={index} className={check.ok ? 'is-pass' : 'is-fail'}>
                    {check.ok ? '✓' : '✗'} [{check.stage}] {check.name}: expected {check.expected};
                    actual {check.actual}
                  </li>
                ))}
                {activeCase.blockedEffects.map((effect, index) => (
                  <li key={`blocked-${index}`} className="is-muted">
                    refused {effect.kind}: {effect.detail}
                  </li>
                ))}
              </ul>
              <pre className="git-diff diag-timeline">
                {activeCase.timeline
                  .map(
                    (event) =>
                      `${String(event.atMs).padStart(6)}ms  ${event.kind.padEnd(14)} ${event.summary}${event.detail ? `\n${' '.repeat(24)}${event.detail.replace(/\n/g, `\n${' '.repeat(24)}`)}` : ''}`
                  )
                  .join('\n')}
                {activeCase.timelineTruncated ? '\n… timeline truncated' : ''}
              </pre>
              {answer && answer.kind === 'answer' && (
                <details className="diag-limits">
                  <summary>Final answer ({activeCase.answerChars} chars, stored locally)</summary>
                  <pre className="git-diff diag-timeline">{answer.text}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
