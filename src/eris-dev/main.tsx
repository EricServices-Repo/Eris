import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  DevApi,
  DevModelOption,
  DevComparison,
  DevImportPreview,
  DevRunListing,
  DevQuestion,
  DevResult,
  DevSummary,
  IntentReplyMode
} from '../shared/eris-dev'
import './style.css'
declare global {
  interface Window {
    erisDev: DevApi
  }
}

const attention = (r: DevSummary) =>
  r.completion?.status === 'incomplete' ||
  r.completion?.status === 'failed' ||
  r.status === 'error' ||
  r.status === 'blocked' ||
  r.status === 'cancelled' ||
  r.stages.inference === 'error' ||
  r.deliverable?.status === 'fail' ||
  r.findings.defect > 0
/** Deterministic answer checks flagged something; a review candidate, not a grade. */
const needsReview = (r: DevSummary) =>
  r.deliverable?.status === 'fail' || r.deliverable?.status === 'needs-review'
/** Completed transport whose answer did not fail the deliverable checks. */
const answered = (r?: DevSummary) =>
  Boolean(
    r &&
    r.stages.inference === 'completed' &&
    (!r.completion || r.completion.status === 'completed') &&
    r.deliverable?.status !== 'fail'
  )
const statusOf = (r?: DevSummary) =>
  !r
    ? 'Pending'
    : r.completion?.status === 'incomplete'
      ? 'Incomplete'
      : r.completion?.status === 'failed'
        ? 'Needs attention'
        : r.stages.inference === 'completed' && r.deliverable?.status === 'fail'
          ? 'Answer failed checks'
          : r.stages.inference === 'completed'
            ? r.deliverable?.status === 'needs-review'
              ? 'Answered · review'
              : 'Answered'
            : attention(r)
              ? 'Needs attention'
              : r.status === 'captured'
                ? 'Request captured'
                : r.status

/** Plain text and code blocks; model output is never interpreted as HTML. */
function Answer({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let offset = 0
  for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g)) {
    if (match.index! > offset)
      parts.push(
        <div className="answer-prose" key={offset}>
          {text.slice(offset, match.index)}
        </div>
      )
    parts.push(
      <div className="code-block" key={`code-${match.index}`}>
        <small>{match[1] || 'Code'}</small>
        <pre>
          <code>{match[2]}</code>
        </pre>
      </div>
    )
    offset = match.index! + match[0].length
  }
  if (offset < text.length)
    parts.push(
      <div className="answer-prose" key={offset}>
        {text.slice(offset)}
      </div>
    )
  return <>{parts}</>
}

function App() {
  const [qualityCalls, setQualityCalls] = useState(24)
  const [qualityTokens, setQualityTokens] = useState(32768)
  const [qualityRepeats, setQualityRepeats] = useState(1)
  const [qualityModel, setQualityModel] = useState('')
  const [qualityRunning, setQualityRunning] = useState(false)
  const [qualityResult, setQualityResult] = useState<
    import('../shared/quality').QualitySummary | null
  >(null)
  const [execution, setExecution] = useState<'capture' | 'live'>('live')
  const [models, setModels] = useState<DevModelOption[]>([])
  const [model, setModel] = useState('')
  const [endpoint, setEndpoint] = useState('http://localhost:11434/v1')
  const [apiKey, setApiKey] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [questions, setQuestions] = useState<DevQuestion[]>([])
  const [preview, setPreview] = useState<DevImportPreview | null>(null)
  const [name, setName] = useState('No file selected')
  const [project, setProject] = useState('Sample project')
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [batch, setBatch] = useState<{ number: number; total: number } | null>(null)
  const [results, setResults] = useState<Record<number, DevSummary>>({})
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<DevResult | null>(null)
  const [context, setContext] = useState(8192)
  const [memoryMode, setMemoryMode] = useState<'independent' | 'stateful' | 'pressure'>(
    'independent'
  )
  const [memoryAlternateModel, setMemoryAlternateModel] = useState('')
  const [memoryEpisodeSize, setMemoryEpisodeSize] = useState(10)
  const [memoryShareRemote, setMemoryShareRemote] = useState(false)
  const [mode, setMode] = useState<'ask' | 'agent'>('agent')
  const [deadline, setDeadline] = useState(180000)
  const [intentReplyMode, setIntentReplyMode] = useState<IntentReplyMode>('fallback')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState(0)
  const [tab, setTab] = useState<'answer' | 'request' | 'diagnostics'>('answer')
  const [diagnostic, setDiagnostic] = useState('overview')
  const [callIndex, setCallIndex] = useState(0)
  const [runs, setRuns] = useState<DevRunListing[]>([])
  const [runPage, setRunPage] = useState(0)
  const [comparison, setComparison] = useState<DevComparison | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'answers' | 'review' | 'attention' | 'pending'>(
    'all'
  )
  const [panel, setPanel] = useState<'settings' | 'history' | 'export' | 'comparison' | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const locked = running || busy || qualityRunning
  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (panel) dialog.current?.showModal()
    else dialog.current?.close()
  }, [panel])
  useEffect(
    () =>
      window.erisDev.onProgress((event) => {
        setRunning(event.running)
        setCompleted(event.completed)
        if (event.batch) setBatch(event.batch)
        if (event.result)
          setResults((previous) => ({ ...previous, [event.result!.index]: event.result! }))
        if (event.error) setError(event.error)
      }),
    []
  )
  useEffect(() => {
    if (!running)
      void window.erisDev
        .listRuns()
        .then(setRuns)
        .catch((err) => setError(String(err)))
  }, [running])
  useEffect(() => {
    void window.erisDev
      .models()
      .then(setModels)
      .catch((err) => setError(String(err)))
  }, [])
  const selectedResult = results[selected]
  useEffect(() => {
    const current = ++generation.current
    setDetail(null)
    setCallIndex(0)
    if (selectedResult)
      void window.erisDev
        .result(selected)
        .then((value) => {
          if (current === generation.current) {
            setDetail(value)
            setCallIndex(Math.max(0, value.requests.length - 1))
          }
        })
        .catch((err) => {
          if (current === generation.current) setError(String(err))
        })
  }, [selected, selectedResult])
  const summaries = useMemo(() => Object.values(results), [results])
  const generated = summaries.filter(answered).length
  const issues = summaries.filter(attention).length
  const visible = useMemo(
    () =>
      questions
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry, index }) => {
          if (search && !`${entry.text} ${entry.id}`.toLowerCase().includes(search.toLowerCase()))
            return false
          const r = results[index]
          return (
            filter === 'all' ||
            (filter === 'pending' && !r) ||
            (filter === 'answers' && answered(r)) ||
            (filter === 'review' && r && needsReview(r)) ||
            (filter === 'attention' && r && attention(r))
          )
        }),
    [questions, results, search, filter]
  )
  const pageCount = Math.max(1, Math.ceil(visible.length / 100))
  useEffect(() => setPage((p) => Math.min(p, pageCount - 1)), [pageCount])
  const call = detail?.requests[callIndex]
  const resetView = () => {
    setSelected(0)
    setPage(0)
    setSearch('')
    setFilter('all')
    setDetail(null)
    setComparison(null)
    setBatch(null)
    setNotice('')
  }
  const importFile = () =>
    attempt(async () => {
      const file = await window.erisDev.importQuestions()
      if (!file) return
      setQuestions(file.questions)
      setPreview(file)
      setName(file.name)
      setResults({})
      setCompleted(0)
      resetView()
    })
  const start = () =>
    attempt(async () => {
      const previous = { results, completed }
      resetView()
      setResults({})
      setCompleted(0)
      setRunning(true)
      setTab(execution === 'live' ? 'answer' : 'request')
      try {
        await window.erisDev.start({
          context,
          mode,
          intentReplyMode,
          memoryMode,
          ...(execution === 'live' && memoryMode !== 'independent' && memoryAlternateModel
            ? { memoryAlternateModel }
            : {}),
          memoryEpisodeSize,
          memoryShareRemote,
          ...(execution === 'live'
            ? { live: { model, batchSize: 10, timeoutMs: deadline, maxCalls: 12 } }
            : {})
        })
      } catch (err) {
        setRunning(false)
        setResults(previous.results)
        setCompleted(previous.completed)
        throw err
      }
    })
  const exportResults = (sanitized: boolean, filtered = false) =>
    attempt(async () => {
      const saved = await window.erisDev.exportRun({
        sanitized,
        ...(filtered
          ? { indices: visible.filter((v) => results[v.index]).map((v) => v.index) }
          : {})
      })
      if (saved) {
        setPanel(null)
        setNotice(`Saved ${saved.records.toLocaleString()} results to ${saved.path}`)
      }
    })
  const openRun = (item: DevRunListing, resume: boolean) =>
    attempt(async () => {
      const opened = await window.erisDev.openRun(item.runId)
      resetView()
      setQuestions(opened.corpus.questions)
      setName(opened.corpus.name)
      setResults(Object.fromEntries(opened.results.map((r) => [r.index, r])))
      setCompleted(opened.results.length)
      setExecution(opened.header.responses === 'live' ? 'live' : 'capture')
      if (opened.header.live) {
        setModel(opened.header.live.model)
        setDeadline(opened.header.live.timeoutMs)
      }
      setContext(opened.header.context)
      setMode(opened.header.mode)
      setMemoryMode(opened.header.memory?.mode ?? 'independent')
      setMemoryAlternateModel(opened.header.memory?.alternateModel ?? '')
      setMemoryEpisodeSize(opened.header.memory?.episodeSize ?? 10)
      setMemoryShareRemote(opened.header.memory?.shareRemote ?? false)
      setIntentReplyMode(opened.header.intentReplyMode)
      setPreview(null)
      setTab(opened.header.responses === 'live' ? 'answer' : 'request')
      setPanel(null)
      if (resume) {
        setRunning(true)
        try {
          const resumed = await window.erisDev.resumeRun(item.runId)
          setResults((previous) => ({
            ...Object.fromEntries(resumed.results.map((r) => [r.index, r])),
            ...previous
          }))
          setCompleted((previous) => Math.max(previous, resumed.next))
        } catch (err) {
          setRunning(false)
          throw err
        }
      }
      if (opened.invalid.length)
        setNotice(`${opened.invalid.length} saved results need to be recaptured.`)
    })
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">E</span>
          <strong>Eris-Dev</strong>
          <span className="muted">Agent testing</span>
        </div>
        <div className="header-actions">
          <button disabled={locked} onClick={() => setPanel('history')}>
            Past runs
          </button>
          <button disabled={locked} onClick={() => setPanel('settings')}>
            Settings
          </button>
        </div>
      </header>
      <section className="run-bar" aria-label="Run questions">
        <div className="file-control">
          <button disabled={locked} onClick={() => void importFile()}>
            {questions.length ? 'Change file' : 'Import questions'}
          </button>
          <div className="file-info">
            <strong title={name}>{name}</strong>
            <span>
              {questions.length
                ? `${questions.length.toLocaleString()} questions · batches of 10`
                : 'TXT, JSON or JSONL · up to 10,000 questions'}
            </span>
          </div>
        </div>
        <label className="model-control">
          <span>Model</span>
          <select
            aria-label="Model"
            disabled={locked || connecting}
            value={execution === 'capture' ? '__capture__' : model}
            onChange={(e) => {
              if (e.target.value === '__capture__') setExecution('capture')
              else {
                setExecution('live')
                setModel(e.target.value)
              }
            }}
          >
            <option value="">Choose a model…</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {model && !models.some((m) => m.id === model) && (
              <option value={model}>Saved model · reconnect in Settings</option>
            )}
            <option value="__capture__">Capture requests only (no model)</option>
          </select>
        </label>
        {running || qualityRunning ? (
          <button
            className="stop"
            disabled={busy}
            onClick={() => void attempt(() => window.erisDev.stop())}
          >
            Stop run
          </button>
        ) : (
          <button
            className="primary"
            disabled={locked || connecting || !questions.length || (execution === 'live' && !model)}
            onClick={() => void start()}
          >
            {busy ? 'Preparing…' : 'Run questions'}
          </button>
        )}
        <button disabled={locked || !completed} onClick={() => setPanel('export')}>
          Export results
        </button>
      </section>
      <details className="quality-suite">
        <summary>Quality suite · production runtime</summary>
        <p>
          Runs built-in isolated fixtures through the same chat pipeline. Live calls require a
          selected model and the explicit budgets below. Host commands remain blocked; correctness
          stays unresolved until independently reviewed.
        </p>
        <label>
          Memory testing{' '}
          <select
            disabled={locked}
            value={memoryMode}
            onChange={(event) => setMemoryMode(event.target.value as typeof memoryMode)}
          >
            <option value="independent">Independent questions</option>
            <option value="stateful">Stateful RAM episodes</option>
            <option value="pressure">Stateful · simulated cache pressure</option>
          </select>
        </label>
        {memoryMode !== 'independent' && (
          <>
            <label>
              Switch model halfway through each episode{' '}
              <select
                disabled={locked || execution !== 'live'}
                value={memoryAlternateModel}
                onChange={(event) => setMemoryAlternateModel(event.target.value)}
              >
                <option value="">Keep selected model</option>
                {models
                  .filter((option) => option.id !== model)
                  .map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Questions per episode{' '}
              <input
                type="number"
                min={2}
                max={10000}
                disabled={locked}
                value={memoryEpisodeSize}
                onChange={(event) => setMemoryEpisodeSize(Number(event.target.value))}
              />
            </label>
            <label>
              <input
                type="checkbox"
                disabled={locked}
                checked={memoryShareRemote}
                onChange={(event) => setMemoryShareRemote(event.target.checked)}
              />{' '}
              Allow recalled test history in remote requests
            </label>
            <p>
              Episodes deliberately share prior questions and observed answers. Capture mode uses
              only explicitly supplied memory.scriptedResponse; no model answer is invented. Source
              IDs are question-id:u and question-id:a. Simulated pressure clears RAM on alternate
              turns. File edits across resumed episodes are not replayed.
            </p>
          </>
        )}
        <label>
          Compare model{' '}
          <select
            disabled={locked}
            value={qualityModel}
            onChange={(e) => setQualityModel(e.target.value)}
          >
            <option value="">Only selected model</option>
            {models
              .filter((m) => m.id !== model)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Repeats{' '}
          <input
            type="number"
            min={1}
            max={10}
            disabled={locked}
            value={qualityRepeats}
            onChange={(e) => setQualityRepeats(Number(e.target.value))}
          />
        </label>
        <label>
          Provider call budget{' '}
          <input
            type="number"
            min={6}
            max={2000}
            disabled={locked}
            value={qualityCalls}
            onChange={(e) => setQualityCalls(Number(e.target.value))}
          />
        </label>
        <label>
          Output token budget{' '}
          <input
            type="number"
            min={128}
            max={2000000}
            disabled={locked}
            value={qualityTokens}
            onChange={(e) => setQualityTokens(Number(e.target.value))}
          />
        </label>
        <button
          disabled={locked || execution !== 'live' || !model}
          onClick={() =>
            void attempt(async () => {
              setQualityRunning(true)
              try {
                setQualityResult(
                  await window.erisDev.quality({
                    models: qualityModel ? [model, qualityModel] : [model],
                    context,
                    repeats: qualityRepeats,
                    maxCalls: qualityCalls,
                    maxOutputTokens: qualityTokens,
                    live: true
                  })
                )
              } finally {
                setQualityRunning(false)
              }
            })
          }
        >
          Run quality suite with model
        </button>
        {qualityRunning && (
          <button onClick={() => void window.erisDev.stop()}>Stop quality suite</button>
        )}
        <button
          disabled={locked}
          onClick={() =>
            void attempt(async () => setQualityResult(await window.erisDev.qualityOpen()))
          }
        >
          Open saved suite
        </button>
        <button
          disabled={locked || !qualityResult}
          onClick={() =>
            void attempt(async () => {
              const path = await window.erisDev.qualityExport()
              if (path) setNotice('Quality report exported: ' + path)
            })
          }
        >
          Export quality report
        </button>
        <button
          disabled={locked || !qualityResult}
          onClick={() =>
            void attempt(async () => {
              const reviewed = await window.erisDev.qualityReview()
              if (reviewed) setQualityResult(reviewed)
            })
          }
        >
          Import adjudications
        </button>
        {qualityResult && (
          <p role="status">
            {qualityResult.observed} observed · {qualityResult.unresolved} unresolved ·{' '}
            {qualityResult.skipped} budget-skipped. Saved: {qualityResult.path}
          </p>
        )}
      </details>
      <section className="progress-bar" aria-label="Run progress">
        <span className={`status-dot ${running ? 'running' : ''}`} />
        <strong>
          {qualityRunning
            ? 'Running quality suite'
            : running
              ? 'Running'
              : completed
                ? 'Run saved'
                : 'Ready'}
        </strong>
        <span>
          {completed.toLocaleString()} / {questions.length.toLocaleString()}
        </span>
        <progress aria-label="Questions completed" value={completed} max={questions.length || 1} />
        {running && batch && (
          <span>
            Batch {batch.number} / {batch.total}
          </span>
        )}
        {generated > 0 && <span>{generated.toLocaleString()} answers</span>}
        {issues > 0 && (
          <button
            className="text-button warning"
            onClick={() => {
              setFilter('attention')
              setPage(0)
            }}
          >
            {issues.toLocaleString()} need attention
          </button>
        )}
        <span className="muted">
          {execution === 'capture' ? 'Requests only' : 'Answers saved automatically'}
        </span>
      </section>
      {error && !panel && (
        <div role="alert" className="banner error">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="banner notice">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}
      <main>
        <aside aria-label="Questions">
          <div className="list-heading">
            <strong>Questions</strong>
            <span className="muted">{visible.length.toLocaleString()}</span>
          </div>
          <div className="filters">
            <input
              aria-label="Search questions"
              type="search"
              placeholder="Search questions…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
            <select
              aria-label="Filter results"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as typeof filter)
                setPage(0)
              }}
            >
              <option value="all">All questions</option>
              <option value="answers">Answered</option>
              <option value="review">Answer checks flagged</option>
              <option value="attention">Needs attention</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <div className="question-list">
            {visible.slice(page * 100, (page + 1) * 100).map(({ entry, index }) => (
              <button
                key={entry.id}
                className={`question ${selected === index ? 'selected' : ''}`}
                aria-pressed={selected === index}
                onClick={() => setSelected(index)}
              >
                <span className="question-number">{index + 1}</span>
                <span className="question-copy">
                  <span className="question-text">{entry.text}</span>
                  <small className={results[index] && attention(results[index]!) ? 'warning' : ''}>
                    {statusOf(results[index])}
                  </small>
                </span>
              </button>
            ))}
            {!visible.length && (
              <p className="list-empty">
                {questions.length
                  ? 'No matching questions.'
                  : 'Import a question file to get started.'}
              </p>
            )}
          </div>
          {pageCount > 1 && (
            <div className="pagination">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                {page + 1} / {pageCount}
              </span>
              <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          )}
        </aside>
        <article aria-label="Selected question">
          {questions.length ? (
            <>
              <div className="detail-heading">
                <span className="eyebrow">Question {selected + 1}</span>
                <h1>{questions[selected]?.text}</h1>
                {detail && (
                  <p className="muted">
                    {statusOf(detail)} · {(detail.durationMs / 1000).toFixed(1)}s
                    {detail.agent ? ` · ${detail.agent}` : ''}
                  </p>
                )}
              </div>
              <nav aria-label="Result views">
                {(['answer', 'request', 'diagnostics'] as const).map((value) => (
                  <button
                    key={value}
                    className={tab === value ? 'active' : ''}
                    aria-pressed={tab === value}
                    onClick={() => setTab(value)}
                  >
                    {value === 'answer'
                      ? 'Answer'
                      : value === 'request'
                        ? 'Model request'
                        : 'Debug details'}
                  </button>
                ))}
              </nav>
              <div className="result-content">
                {detail ? (
                  <>
                    {tab === 'answer' && (
                      <>
                        {detail.completion?.status === 'incomplete' && (
                          <div className="inline-error">
                            This agent run did not finish. Review the model requests and debug
                            details before retrying.
                          </div>
                        )}
                        {detail.inference?.error && (
                          <div className="inline-error">{detail.inference.error}</div>
                        )}
                        {detail.deliverable && detail.deliverable.status !== 'pass' && (
                          <div
                            className={
                              detail.deliverable.status === 'fail' ? 'inline-error' : 'notice'
                            }
                          >
                            <strong>
                              Answer checks{' '}
                              {detail.deliverable.status === 'fail' ? 'failed' : 'need review'}
                            </strong>
                            <ul>
                              {detail.deliverable.checks.map((check) => (
                                <li key={check.id}>{check.detail}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {detail.response ? (
                          <Answer text={detail.response} />
                        ) : (
                          <div className="empty-state">
                            <h2>
                              {detail.sourceMode === 'capture'
                                ? 'Request captured'
                                : 'No answer returned'}
                            </h2>
                            <p>
                              {detail.sourceMode === 'capture'
                                ? 'This run saved the request without calling a model. Select Model request to inspect it, or choose a model for your next run.'
                                : detail.detail}
                            </p>
                            {detail.sourceMode === 'capture' && (
                              <button onClick={() => setTab('request')}>View model request</button>
                            )}
                          </div>
                        )}
                        {detail.draft && (
                          <details className="draft">
                            <summary>
                              Last model draft ({detail.draft.length.toLocaleString()} characters) ·
                              not a final answer
                            </summary>
                            <pre>{detail.draft}</pre>
                          </details>
                        )}
                        <p className="answer-note">
                          {detail.response
                            ? 'Generated by the model. Answer quality has not been evaluated.'
                            : ''}
                        </p>
                      </>
                    )}
                    {tab === 'request' && (
                      <>
                        <label className="request-picker">
                          Request
                          <select
                            value={callIndex}
                            onChange={(e) => setCallIndex(Number(e.target.value))}
                          >
                            {detail.requests.map((r, index) => (
                              <option key={index} value={index}>
                                {index + 1} · {r.purpose} · {r.model}
                              </option>
                            ))}
                          </select>
                        </label>
                        {call ? (
                          <>
                            {(call.messages as Array<{ role?: string; content?: unknown }>).map(
                              (message, i) => (
                                <section className="message" key={i}>
                                  <h3>{message.role ?? 'Message'}</h3>
                                  <pre>
                                    {typeof message.content === 'string'
                                      ? message.content
                                      : JSON.stringify(message.content, null, 2)}
                                  </pre>
                                </section>
                              )
                            )}
                            {call.response && (
                              <section className="message">
                                <h3>
                                  Model output
                                  {call.termination ? ` · stopped: ${call.termination.reason}` : ''}
                                </h3>
                                <pre>{call.response}</pre>
                              </section>
                            )}
                          </>
                        ) : (
                          <p>No model request was reached.</p>
                        )}
                      </>
                    )}
                    {tab === 'diagnostics' && (
                      <>
                        <label className="request-picker">
                          Inspect
                          <select
                            value={diagnostic}
                            onChange={(e) => setDiagnostic(e.target.value)}
                          >
                            <option value="overview">Run details</option>
                            <option value="findings">Request findings</option>
                            <option value="tools">Tool definitions</option>
                            <option value="contract">Task contract</option>
                            <option value="context">Routing and context</option>
                            <option value="memory">Memory replay evidence</option>
                            <option value="events">Events</option>
                          </select>
                        </label>
                        <pre>
                          {JSON.stringify(
                            diagnostic === 'overview'
                              ? {
                                  stages: detail.stages,
                                  completion: detail.completion,
                                  termination: detail.termination,
                                  deliverable: detail.deliverable,
                                  inference: detail.inference,
                                  phases: detail.phases,
                                  questionId: detail.questionId,
                                  sourceLine: detail.sourceLine,
                                  detail: detail.detail
                                }
                              : diagnostic === 'findings'
                                ? detail.findingsDetail
                                : diagnostic === 'tools'
                                  ? detail.requests.map((r) => ({
                                      purpose: r.purpose,
                                      tools: r.tools,
                                      toolChoice: r.toolChoice,
                                      schema: r.schema
                                    }))
                                  : diagnostic === 'contract'
                                    ? detail.task
                                    : diagnostic === 'memory'
                                      ? detail.memory
                                      : diagnostic === 'context'
                                        ? {
                                            routeDecision: detail.routeDecision,
                                            retrieval: detail.retrieval,
                                            workflowLint: detail.workflowLint,
                                            requests: detail.requests.map((r) => ({
                                              context: r.context,
                                              toolManifest: r.toolManifest
                                            }))
                                          }
                                        : detail.events,
                            null,
                            2
                          )}
                        </pre>
                      </>
                    )}
                  </>
                ) : (
                  <div className="empty-state">
                    <span className="empty-symbol">…</span>
                    <h2>
                      {selectedResult
                        ? 'Loading result…'
                        : running
                          ? 'Waiting for this answer'
                          : 'Ready to run'}
                    </h2>
                    <p>
                      {running
                        ? 'Questions run one at a time, in batches of 10. Answers appear here as they finish.'
                        : 'Choose a model and click Run questions. Select any completed question to review its answer.'}
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="welcome">
              <span className="eyebrow">A simpler way to test your agents</span>
              <h1>
                Questions in.
                <br />
                Answers to inspect.
              </h1>
              <p>
                Import your questions, choose a model, and run.
                <br />
                Results are saved in batches of 10.
              </p>
              <button className="primary" disabled={locked} onClick={() => void importFile()}>
                Import questions
              </button>
              <span className="muted">You can also reopen a previous run.</span>
            </div>
          )}
        </article>
      </main>
      <dialog
        ref={dialog}
        onCancel={() => setPanel(null)}
        aria-label={
          panel === 'settings'
            ? 'Settings'
            : panel === 'history'
              ? 'Past runs'
              : panel === 'export'
                ? 'Export results'
                : 'Run comparison'
        }
      >
        <div className="dialog-heading">
          <h2>
            {panel === 'settings'
              ? 'Settings'
              : panel === 'history'
                ? 'Past runs'
                : panel === 'export'
                  ? 'Export results'
                  : 'Run comparison'}
          </h2>
          <button onClick={() => setPanel(null)} aria-label="Close dialog">
            Close
          </button>
        </div>
        <div className="dialog-content">
          {panel === 'settings' && (
            <>
              <h3>Model connection</h3>
              <p className="muted">
                Downloaded Eris models and saved connections appear in the model picker.
              </p>
              <div className="setting-actions">
                <button
                  disabled={locked || connecting}
                  onClick={() => void attempt(async () => setModels(await window.erisDev.models()))}
                >
                  Refresh models
                </button>
              </div>
              <details>
                <summary>Connect a model server</summary>
                <p className="muted">
                  Ollama, LM Studio or an OpenAI-compatible API. API requests go to the selected
                  provider.
                </p>
                <label>
                  API URL
                  <input
                    disabled={locked || connecting}
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </label>
                <label>
                  API key · optional, session only
                  <input
                    type="password"
                    autoComplete="off"
                    disabled={locked || connecting}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </label>
                <button
                  disabled={locked || connecting}
                  onClick={() =>
                    void attempt(async () => {
                      setConnecting(true)
                      try {
                        const options = await window.erisDev.connect({ baseUrl: endpoint, apiKey })
                        setModels(options)
                        setModel(options.find((m) => m.label.startsWith('Dev endpoint'))?.id ?? '')
                        setExecution('live')
                        setApiKey('')
                        setNotice('Connected. Choose a model and run your questions.')
                        setPanel(null)
                      } finally {
                        setConnecting(false)
                      }
                    })
                  }
                >
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>
              </details>
              <h3>Workspace</h3>
              <p className="muted">{project}. Each question uses a disposable copy.</p>
              <div className="setting-actions">
                <button
                  disabled={locked}
                  onClick={() =>
                    void attempt(async () => {
                      const value = await window.erisDev.chooseProject()
                      if (value) setProject(value)
                    })
                  }
                >
                  Choose folder
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    void attempt(async () => {
                      await window.erisDev.setProjectKind('sample')
                      setProject('Sample project')
                    })
                  }
                >
                  Use sample
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    void attempt(async () => {
                      await window.erisDev.setProjectKind('none')
                      setProject('No project')
                    })
                  }
                >
                  No project
                </button>
              </div>
              <details>
                <summary>Advanced run settings</summary>
                <div className="settings-grid">
                  <label>
                    Agent mode
                    <select
                      disabled={locked}
                      value={mode}
                      onChange={(e) => setMode(e.target.value as typeof mode)}
                    >
                      <option value="agent">Agent · workspace tools</option>
                      <option value="ask">Ask · answer only</option>
                    </select>
                  </label>
                  <label>
                    Context window
                    <select
                      disabled={locked}
                      value={context}
                      onChange={(e) => setContext(Number(e.target.value))}
                    >
                      {[4096, 8192, 16384, 32768].map((v) => (
                        <option key={v} value={v}>
                          {v.toLocaleString()} tokens
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Time per question
                    <select
                      disabled={locked}
                      value={deadline}
                      onChange={(e) => setDeadline(Number(e.target.value))}
                    >
                      {[60000, 180000, 300000, 600000].map((v) => (
                        <option key={v} value={v}>
                          {v / 60000} minutes
                        </option>
                      ))}
                    </select>
                  </label>
                  {execution === 'capture' && (
                    <label>
                      Simulated intent reply
                      <select
                        disabled={locked}
                        value={intentReplyMode}
                        onChange={(e) => setIntentReplyMode(e.target.value as IntentReplyMode)}
                      >
                        <option value="fallback">Fallback</option>
                        <option value="malformed">Malformed JSON</option>
                        <option value="timeout">Timeout</option>
                      </select>
                    </label>
                  )}
                </div>
                <p className="muted">
                  Batches of 10, one question at a time. Host commands and external tool effects are
                  blocked. Answers are not automatically graded.
                </p>
              </details>
              {preview && (
                <details>
                  <summary>Import details · {preview.excluded.length} excluded lines</summary>
                  <p>{preview.normalization.join(' ')}</p>
                  <pre>{JSON.stringify(preview.excluded, null, 2)}</pre>
                </details>
              )}
            </>
          )}
          {panel === 'history' && (
            <>
              {runs.length ? (
                runs.slice(runPage * 10, (runPage + 1) * 10).map((item) => (
                  <div className="saved-run" key={item.runId}>
                    <div>
                      <strong>{item.corpus}</strong>
                      <p>
                        {new Date(item.created).toLocaleString()} ·{' '}
                        {item.completed.toLocaleString()} / {item.total.toLocaleString()} ·{' '}
                        {item.state}
                      </p>
                    </div>
                    <div className="setting-actions">
                      <button disabled={locked} onClick={() => void openRun(item, false)}>
                        Open
                      </button>
                      {['stopped', 'interrupted'].includes(item.state) && (
                        <button disabled={locked} onClick={() => void openRun(item, true)}>
                          Resume
                        </button>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="muted">Your saved runs will appear here.</p>
              )}
              {runs.length > 10 && (
                <div className="pagination">
                  <button disabled={!runPage} onClick={() => setRunPage(runPage - 1)}>
                    Newer
                  </button>
                  <span>
                    {runPage + 1} / {Math.ceil(runs.length / 10)}
                  </span>
                  <button
                    disabled={(runPage + 1) * 10 >= runs.length}
                    onClick={() => setRunPage(runPage + 1)}
                  >
                    Older
                  </button>
                </div>
              )}
            </>
          )}
          {panel === 'export' && (
            <>
              <p>
                Save {completed.toLocaleString()} results, including questions, answers and model
                requests.
              </p>
              <button
                className="primary wide"
                disabled={locked}
                onClick={() => void exportResults(true)}
              >
                Export with sensitive data redacted
              </button>
              <p className="muted">
                Automated redaction may not remove every sensitive value. Review before sharing.
              </p>
              <details>
                <summary>More options</summary>
                <div className="stack">
                  <button disabled={locked} onClick={() => void exportResults(false)}>
                    Export original JSONL
                  </button>
                  <button
                    disabled={locked || !visible.some((v) => results[v.index])}
                    onClick={() => void exportResults(true, true)}
                  >
                    Export filtered results
                  </button>
                  <button
                    disabled={locked}
                    onClick={() =>
                      void attempt(async () => {
                        const value = await window.erisDev.compareWith()
                        if (value) {
                          setComparison(value)
                          setPanel('comparison')
                        }
                      })
                    }
                  >
                    Compare with another run
                  </button>
                </div>
              </details>
            </>
          )}
          {panel === 'comparison' && comparison && (
            <>
              <p>
                {comparison.matched.toLocaleString()} matched ·{' '}
                {comparison.totalChanged.toLocaleString()} changed · {comparison.added.length} new ·{' '}
                {comparison.removed.length} missing
              </p>
              <p className="muted">
                {comparison.compatibility.status} comparison.{' '}
                {comparison.compatibility.confounders.join('; ')}
              </p>
              <pre>
                {JSON.stringify(
                  {
                    byCategory: comparison.byCategory,
                    byField: comparison.byField,
                    changes: comparison.changed
                  },
                  null,
                  2
                )}
              </pre>
              <div className="pagination">
                <button
                  disabled={busy || !comparison.page.offset}
                  onClick={() =>
                    void attempt(async () => {
                      const next = await window.erisDev.comparePage(
                        Math.max(0, comparison.page.offset - comparison.page.size)
                      )
                      setComparison({ ...comparison, ...next })
                    })
                  }
                >
                  Previous
                </button>
                <span>
                  {comparison.page.offset + 1}–{comparison.page.offset + comparison.page.returned}
                </span>
                <button
                  disabled={
                    busy ||
                    comparison.page.offset + comparison.page.returned >= comparison.totalChanged
                  }
                  onClick={() =>
                    void attempt(async () => {
                      const next = await window.erisDev.comparePage(
                        comparison.page.offset + comparison.page.size
                      )
                      setComparison({ ...comparison, ...next })
                    })
                  }
                >
                  Next
                </button>
              </div>
              <p className="muted">Full report: {comparison.savedTo}</p>
            </>
          )}
        </div>
        {error && (
          <div role="alert" className="banner error">
            {error}
          </div>
        )}
      </dialog>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
