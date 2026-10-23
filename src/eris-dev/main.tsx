import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  DevApi,
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
const RUN_PAGE = 10

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function App() {
  const [questions, setQuestions] = useState<DevQuestion[]>([])
  const [preview, setPreview] = useState<DevImportPreview | null>(null)
  const [intentReplyMode, setIntentReplyMode] = useState<IntentReplyMode>('fallback')
  const [name, setName] = useState('No question file selected')
  const [project, setProject] = useState('Sample project · divide(a, b)')
  const [running, setRunning] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [results, setResults] = useState<Record<number, DevSummary>>({})
  const [selected, setSelected] = useState(0)
  const [detail, setDetail] = useState<DevResult | null>(null)
  const [context, setContext] = useState(8192)
  const [mode, setMode] = useState<'ask' | 'agent'>('agent')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState(0)
  const [tab, setTab] = useState<
    'messages' | 'tools' | 'findings' | 'context' | 'contract' | 'events'
  >('messages')
  const [callIndex, setCallIndex] = useState(0)
  const [runs, setRuns] = useState<DevRunListing[]>([])
  const [runPage, setRunPage] = useState(0)
  const [comparison, setComparison] = useState<DevComparison | null>(null)
  // Filters over loaded summaries; request bodies stay on disk until a case is opened.
  const [search, setSearch] = useState('')
  const [severity, setSeverity] = useState<'all' | 'defects' | 'review' | 'clean'>('all')
  const [findingFilter, setFindingFilter] = useState('')
  const [intentFilter, setIntentFilter] = useState('')
  const generation = useRef(0)
  const attempt = async (fn: () => Promise<void>) => {
    try {
      setError('')
      await fn()
    } catch (err) {
      setError(String(err))
    }
  }
  useEffect(
    () =>
      window.erisDev.onProgress((event) => {
        setRunning(event.running)
        setCompleted(event.completed)
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
        .catch(() => setRuns([]))
  }, [running])
  const available = Boolean(results[selected])
  useEffect(() => {
    const current = ++generation.current
    setDetail(null)
    setCallIndex(0)
    if (available)
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
  }, [selected, available])
  const call = detail?.requests[callIndex]
  const summaries = useMemo(() => Object.values(results), [results])
  const captures = summaries.filter((item) => item.status === 'captured').length
  const withDefects = summaries.filter((item) => item.findings.defect > 0).length
  const forReview = summaries.filter(
    (item) => !item.findings.defect && item.findings.review > 0
  ).length
  // Root-cause families: how many questions each finding ID affects.
  const families = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of summaries)
      for (const id of item.findingIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [summaries])
  const intents = useMemo(
    () => [...new Set(summaries.map((item) => item.intent).filter(Boolean))].sort() as string[],
    [summaries]
  )
  const filtering = Boolean(search.trim() || severity !== 'all' || findingFilter || intentFilter)
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return questions
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => {
        if (!filtering) return true
        const result = results[index]
        if (needle && !`${entry.text} ${entry.id}`.toLowerCase().includes(needle)) return false
        if (!result) return !(severity !== 'all' || findingFilter || intentFilter)
        if (severity === 'defects' && !result.findings.defect) return false
        if (severity === 'review' && !result.findings.review) return false
        if (severity === 'clean' && (result.findings.defect || result.findings.review)) return false
        if (findingFilter && !(result.findingIds ?? []).includes(findingFilter)) return false
        if (intentFilter && result.intent !== intentFilter) return false
        return true
      })
  }, [questions, results, search, severity, findingFilter, intentFilter, filtering])
  const pageCount = Math.max(1, Math.ceil(visible.length / 100))
  return (
    <div className="app">
      <header>
        <div>
          <span className="logo">E</span>
          <strong>Eris-Dev</strong>
          <span className="badge">Agent request inspector</span>
        </div>
        <span className="muted">Local capture · no model inference · answers not evaluated</span>
      </header>
      <section className="controls">
        <div className="intro">
          <h1>See what the agents send.</h1>
          <p>
            Import up to 10,000 questions. Inspect routing, permissions, messages and tool schemas
            at the production model transport boundary.
          </p>
        </div>
        <div className="row">
          <button
            disabled={running}
            onClick={() =>
              void attempt(async () => {
                const file = await window.erisDev.importQuestions()
                if (file) {
                  setQuestions(file.questions)
                  setPreview(file)
                  setName(
                    `${file.name} · ${file.questions.length.toLocaleString()} questions` +
                      (file.excluded.length ? ` · ${file.excluded.length} lines excluded` : '')
                  )
                  setResults({})
                  setCompleted(0)
                  setSelected(0)
                  setPage(0)
                  setDetail(null)
                }
              })
            }
          >
            Import questions
          </button>
          <span className="filename">{name}</span>
          <button
            disabled={running}
            onClick={() =>
              void attempt(async () => {
                const value = await window.erisDev.chooseProject()
                if (value) setProject(value)
              })
            }
          >
            Choose project
          </button>
          <button
            disabled={running}
            onClick={() =>
              void attempt(async () => {
                await window.erisDev.setProjectKind('sample')
                setProject('Sample project · divide(a, b)')
              })
            }
          >
            Sample
          </button>
          <button
            disabled={running}
            onClick={() =>
              void attempt(async () => {
                await window.erisDev.setProjectKind('none')
                setProject('No project · workspace-independent questions')
              })
            }
          >
            No project
          </button>
          <span className="filename" title={project}>
            {project}
          </span>
        </div>
        <div className="row">
          <label>
            Mode{' '}
            <select
              disabled={running}
              value={mode}
              onChange={(e) => setMode(e.target.value as 'ask' | 'agent')}
            >
              <option value="agent">Agent</option>
              <option value="ask">Ask</option>
            </select>
          </label>
          <label>
            Intent reply{' '}
            <select
              disabled={running}
              value={intentReplyMode}
              onChange={(e) => setIntentReplyMode(e.target.value as IntentReplyMode)}
            >
              <option value="fallback">Fallback (confidence 0)</option>
              <option value="malformed">Malformed JSON</option>
              <option value="timeout">Timeout</option>
            </select>
          </label>
          <label>
            Context budget{' '}
            <select
              disabled={running}
              value={context}
              onChange={(e) => setContext(Number(e.target.value))}
            >
              {[4096, 8192, 16384, 32768].map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={running || !questions.length}
            onClick={() =>
              void attempt(async () => {
                setResults({})
                setDetail(null)
                setCompleted(0)
                setRunning(true)
                try {
                  await window.erisDev.start({ context, mode, intentReplyMode })
                } catch (err) {
                  setRunning(false)
                  throw err
                }
              })
            }
          >
            Capture requests
          </button>
          <button
            disabled={!running}
            onClick={() =>
              void attempt(async () => {
                await window.erisDev.stop()
              })
            }
          >
            Stop
          </button>
          <button
            disabled={running || !completed}
            onClick={() =>
              void attempt(async () => {
                const saved = await window.erisDev.exportRun()
                if (saved)
                  setNotice(`Exported ${saved.records.toLocaleString()} records to ${saved.path}`)
              })
            }
          >
            Export JSONL
          </button>
          <button
            disabled={running || !completed}
            title="Automated redaction of known secret formats, credential fields and absolute paths; question IDs, relative paths and traces are kept. Not a guarantee that all sensitive data is removed."
            onClick={() =>
              void attempt(async () => {
                const saved = await window.erisDev.exportRun({ sanitized: true })
                if (saved)
                  setNotice(
                    `Exported a copy with automated redaction to ${saved.path}. Redactions: ${
                      Object.entries(saved.redaction?.replacements ?? {})
                        .map(([kind, count]) => `${kind} ${count}`)
                        .join(', ') || 'none found'
                    }. Automated redaction is not a guarantee: ${(saved.redaction?.limitations ?? []).join(' ')}`
                  )
              })
            }
          >
            Export sanitized
          </button>
          <button
            disabled={running || !completed || !filtering}
            title="Export only the questions matching the current filters, sanitized"
            onClick={() =>
              void attempt(async () => {
                const indices = visible.map(({ index }) => index).filter((index) => results[index])
                const saved = await window.erisDev.exportRun({ sanitized: true, indices })
                if (saved) setNotice(`Exported ${saved.records} filtered records to ${saved.path}`)
              })
            }
          >
            Export filtered
          </button>
          <button
            disabled={running || !completed}
            title="Compare this run with an earlier export by stable question ID"
            onClick={() =>
              void attempt(async () => {
                const result = await window.erisDev.compareWith()
                if (result) setComparison(result)
              })
            }
          >
            Compare…
          </button>
          <span className="muted" aria-live="polite">
            {completed.toLocaleString()} / {questions.length.toLocaleString()}{' '}
            {running ? '· running' : '· idle'}
          </span>
        </div>
        <progress value={completed} max={questions.length || 1} />
        {completed > 0 && (
          <p className="stages" aria-live="polite">
            <span>{captures.toLocaleString()} request captures</span>
            <span>0 generated answers</span>
            <span>answer quality not evaluated</span>
            <span className={withDefects ? 'defects' : ''}>
              {withDefects.toLocaleString()} with request defects
            </span>
            <span>{forReview.toLocaleString()} for review</span>
          </p>
        )}
        {!running && runs.length > 0 && (
          <details className="hint">
            <summary>
              Saved runs ({runs.length.toLocaleString()}) ·{' '}
              {formatBytes(runs.reduce((sum, item) => sum + (item.bytes ?? 0), 0))} on disk
            </summary>
            <ul>
              {runs.slice(runPage * RUN_PAGE, (runPage + 1) * RUN_PAGE).map((item) => (
                <li key={item.runId}>
                  {new Date(item.created).toLocaleString()} · {item.corpus} · {item.state} ·{' '}
                  {item.completed.toLocaleString()} / {item.total.toLocaleString()} ·{' '}
                  {item.mode ?? '—'} · {item.context ?? '—'} tokens · {item.fixture ?? '—'} ·{' '}
                  {item.gitSha ? item.gitSha.slice(0, 8) : 'source unknown'} ·{' '}
                  {formatBytes(item.bytes ?? 0)}{' '}
                  <button
                    title="Open this run's saved results without running anything"
                    onClick={() =>
                      void attempt(async () => {
                        const opened = await window.erisDev.openRun(item.runId)
                        setQuestions(opened.corpus.questions)
                        setPreview(null)
                        setName(`${opened.corpus.name} · ${opened.state} run (read-only)`)
                        setResults(Object.fromEntries(opened.results.map((r) => [r.index, r])))
                        setCompleted(opened.results.length)
                        setComparison(null)
                        if (opened.invalid.length)
                          setNotice(
                            `Stopped at case ${opened.invalid[0]!.index + 1}: ${opened.invalid[0]!.reason}.`
                          )
                      })
                    }
                  >
                    Open
                  </button>
                  {(item.state === 'interrupted' || item.state === 'stopped') && (
                    <button
                      onClick={() =>
                        void attempt(async () => {
                          const resumed = await window.erisDev.resumeRun(item.runId)
                          setQuestions(resumed.corpus.questions)
                          setPreview(null)
                          setName(
                            `${resumed.corpus.name} · resumed at question ${resumed.next + 1}`
                          )
                          setResults(Object.fromEntries(resumed.results.map((r) => [r.index, r])))
                          setCompleted(resumed.next)
                          setRunning(true)
                          if (resumed.invalid.length)
                            setNotice(
                              `Recapturing ${resumed.invalid.length} saved case(s): ${resumed.invalid
                                .map((entry) => `${entry.index + 1} (${entry.reason})`)
                                .join(', ')}.`
                            )
                        })
                      }
                    >
                      Resume
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {runs.length > RUN_PAGE && (
              <p>
                <button disabled={runPage === 0} onClick={() => setRunPage(runPage - 1)}>
                  Newer
                </button>{' '}
                Page {runPage + 1} of {Math.ceil(runs.length / RUN_PAGE)}{' '}
                <button
                  disabled={(runPage + 1) * RUN_PAGE >= runs.length}
                  onClick={() => setRunPage(runPage + 1)}
                >
                  Older
                </button>
              </p>
            )}
          </details>
        )}
        {comparison && (
          <details className="hint" open>
            <summary>
              Compared with {comparison.file}: {comparison.matched.toLocaleString()} matched ·{' '}
              {comparison.totalChanged.toLocaleString()} changed · {comparison.added.length} new ·{' '}
              {comparison.removed.length} missing. Task IDs, paths and timings are ignored.
            </summary>
            <p className={comparison.compatibility.status === 'controlled' ? '' : 'defects'}>
              {comparison.compatibility.status === 'controlled'
                ? 'Controlled comparison: the runs differ only in the code under test'
                : comparison.compatibility.status === 'legacy'
                  ? 'Legacy export: its settings and fixture are unknown, so differences may not be regressions'
                  : 'Confounded comparison: differences may come from the run setup, not the code'}
              {comparison.compatibility.confounders.length
                ? ` — ${comparison.compatibility.confounders.join('; ')}`
                : ''}
              {comparison.compatibility.controlled.length
                ? `. Code under test: ${comparison.compatibility.controlled.join('; ')}`
                : ''}
              .
              {comparison.identity.legacyMigrated > 0 && (
                <>
                  <br />
                  {comparison.identity.legacyMigrated.toLocaleString()} legacy records were matched
                  by question text
                  {comparison.identity.ambiguous.length
                    ? `; ${comparison.identity.ambiguous.length} duplicated question(s) are paired by order and may be ambiguous`
                    : ''}
                  .
                </>
              )}
              {comparison.duplicates.before.length + comparison.duplicates.after.length > 0 && (
                <>
                  <br />
                  Duplicate IDs left out of the comparison:{' '}
                  {[...comparison.duplicates.before, ...comparison.duplicates.after].join(', ')}
                </>
              )}
            </p>
            <p>
              Changed categories:{' '}
              {Object.entries(comparison.byCategory)
                .map(([category, count]) => `${category} ${count}`)
                .join(' · ') || 'none'}
              <br />
              Changed fields:{' '}
              {Object.entries(comparison.byField)
                .map(([field, count]) => `${field} ${count}`)
                .join(' · ') || 'none'}
              <br />
              Route transitions:{' '}
              {Object.entries(comparison.transitions)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([transition, count]) => `${transition} (${count})`)
                .join(' · ') || 'none'}
            </p>
            <ul>
              {comparison.changed.map((item) => (
                <li key={item.questionId}>
                  Line {item.sourceLine}: {item.question.slice(0, 90)} —{' '}
                  {Object.entries(item.changes)
                    .map(([field, change]) =>
                      change.detail
                        ? `${field}: ${change.detail}`
                        : `${field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`
                    )
                    .join('; ')
                    .slice(0, 400)}
                </li>
              ))}
            </ul>
            <p className="muted">
              Showing {comparison.totalChanged ? comparison.page.offset + 1 : 0}–
              {comparison.page.offset + comparison.page.returned} of{' '}
              {comparison.totalChanged.toLocaleString()} changed questions (page size{' '}
              {comparison.page.size}). The full comparison is saved to {comparison.savedTo}.
            </p>
            <button
              disabled={comparison.page.offset === 0}
              onClick={() =>
                void attempt(async () => {
                  const page = await window.erisDev.comparePage(
                    Math.max(0, comparison.page.offset - comparison.page.size)
                  )
                  setComparison({ ...comparison, changed: page.changed, page: page.page })
                })
              }
            >
              Previous page
            </button>{' '}
            <button
              disabled={
                comparison.page.offset + comparison.page.returned >= comparison.totalChanged
              }
              onClick={() =>
                void attempt(async () => {
                  const page = await window.erisDev.comparePage(
                    comparison.page.offset + comparison.page.size
                  )
                  setComparison({ ...comparison, changed: page.changed, page: page.page })
                })
              }
            >
              Next page
            </button>{' '}
            <button onClick={() => setComparison(null)}>Close comparison</button>
          </details>
        )}
        {preview && (preview.excluded.length > 0 || preview.normalization.length > 0) && (
          <details className="hint">
            <summary>
              Import: {preview.normalization.join(' ') || 'No normalization.'} Corpus{' '}
              {preview.corpusId}
            </summary>
            <ul>
              {preview.excluded.slice(0, 50).map((line) => (
                <li key={line.sourceLine}>
                  Line {line.sourceLine}: {line.reason} — “{line.text.slice(0, 120)}”
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="hint">
          Each question is an independent turn. A selected project is copied into a temporary
          workspace; secrets, build output and most hidden entries are excluded, and each omission
          is listed in the export header. Intent-model requests receive the selected labelled reply.
          Agent capture stops before inference or tool execution, so no answer is generated or
          graded. Exports include prompt/source text.
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}
      </section>
      <main>
        <aside>
          <div className="list-title">
            Questions{' '}
            <span>
              {filtering
                ? `${visible.length.toLocaleString()} of ${questions.length.toLocaleString()}`
                : questions.length.toLocaleString()}
            </span>
          </div>
          <div className="filters">
            <input
              type="search"
              placeholder="Search text or ID"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
            <select
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value as typeof severity)
                setPage(0)
              }}
            >
              <option value="all">All findings</option>
              <option value="defects">With defects</option>
              <option value="review">For review</option>
              <option value="clean">No findings</option>
            </select>
            <select
              value={intentFilter}
              onChange={(e) => {
                setIntentFilter(e.target.value)
                setPage(0)
              }}
            >
              <option value="">Any intent</option>
              {intents.map((intent) => (
                <option key={intent} value={intent}>
                  {intent}
                </option>
              ))}
            </select>
          </div>
          {families.length > 0 && (
            <div className="families">
              {families.slice(0, 8).map(([id, count]) => (
                <button
                  key={id}
                  className={findingFilter === id ? 'active' : ''}
                  onClick={() => {
                    setFindingFilter(findingFilter === id ? '' : id)
                    setPage(0)
                  }}
                >
                  {id} · {count.toLocaleString()}
                </button>
              ))}
            </div>
          )}
          <div className="list">
            {visible.slice(page * 100, page * 100 + 100).map(({ entry, index }) => {
              const result = results[index]
              return (
                <button
                  key={entry.id}
                  className={`question ${selected === index ? 'selected' : ''}`}
                  onClick={() => setSelected(index)}
                  title={`${entry.id} · source line ${entry.sourceLine}`}
                >
                  <span className="number">{index + 1}</span>
                  <span>
                    <span className="question-text">{entry.text}</span>
                    <small className={result ? result.stages.requestValidity : undefined}>
                      {result
                        ? `${result.status === 'captured' ? 'reached boundary' : result.status} · ${result.agent ?? 'no agent'} · ${result.intent ?? 'unresolved'}${result.artifact ? ` → ${result.artifact}` : ''}${result.findings.defect ? ` · ${result.findings.defect} defect(s)` : result.findings.review ? ` · ${result.findings.review} for review` : ''}`
                        : 'Pending'}
                    </small>
                  </span>
                </button>
              )
            })}
            {!questions.length && (
              <p className="empty">
                Import a TXT file with one question per line, a JSON array, or JSONL records
                containing “question” or “text”.
              </p>
            )}
          </div>
          <div className="pagination">
            <button disabled={!page} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <button disabled={(page + 1) * 100 >= visible.length} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </aside>
        <article>
          <div className="detail-title">
            <h2>{questions[selected]?.text ?? 'Model request preview'}</h2>
            {detail && (
              <p>
                Reachability {detail.stages.reachability} · request validity{' '}
                {detail.stages.requestValidity} · inference not run · answer quality not evaluated
                <br />
                Pre-inference duration {detail.durationMs} ms (route {detail.phases.routeMs},
                resolve {detail.phases.resolveMs}, prompt {detail.phases.promptMs}, to boundary{' '}
                {detail.phases.toBoundaryMs}) · {detail.calls} requests · intent reply{' '}
                {detail.intentReplySource} · {detail.questionId}, source line {detail.sourceLine}
              </p>
            )}
          </div>
          <nav>
            {(['messages', 'tools', 'findings', 'context', 'contract', 'events'] as const).map(
              (value) => (
                <button
                  key={value}
                  className={tab === value ? 'active' : ''}
                  onClick={() => setTab(value)}
                >
                  {value}
                </button>
              )
            )}
          </nav>
          <div className="content">
            {detail ? (
              <>
                <p className="hint">{detail.detail}</p>
                {(tab === 'messages' || tab === 'tools') && (
                  <>
                    <label>
                      Captured request{' '}
                      <select
                        value={callIndex}
                        onChange={(e) => setCallIndex(Number(e.target.value))}
                      >
                        {detail.requests.map((request, index) => (
                          <option key={index} value={index}>
                            {index + 1} · {request.purpose} · {request.model}
                          </option>
                        ))}
                      </select>
                    </label>
                    {call ? (
                      <>
                        <p className="muted">
                          Temperature {call.temperature} · {call.tools.length} tool definitions
                        </p>
                        <pre>
                          {JSON.stringify(
                            tab === 'messages'
                              ? call.messages
                              : {
                                  tools: call.tools,
                                  toolChoice: call.toolChoice,
                                  schema: call.schema
                                },
                            null,
                            2
                          )}
                        </pre>
                      </>
                    ) : (
                      <p>
                        No model request was reached. Inspect the contract and events for the
                        blocking reason.
                      </p>
                    )}
                  </>
                )}
                {tab === 'findings' &&
                  (detail.findingsDetail.length ? (
                    <ul className="findings">
                      {detail.findingsDetail.map((finding) => (
                        <li key={finding.id} className={finding.severity}>
                          <strong>{finding.id}</strong> · {finding.severity} · {finding.detail}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      No request-level findings. This checks request coherence only; it is not an
                      answer quality pass.
                    </p>
                  ))}
                {tab === 'context' && (
                  <pre>
                    {JSON.stringify(
                      {
                        routeDecision: detail.routeDecision ?? null,
                        retrieval: detail.retrieval ?? null,
                        workflowLint: detail.workflowLint ?? null,
                        requests: detail.requests.map((request) => ({
                          purpose: request.purpose,
                          context: request.context ?? null,
                          toolManifest: request.toolManifest ?? null
                        }))
                      },
                      null,
                      2
                    )}
                  </pre>
                )}
                {tab === 'contract' && <pre>{JSON.stringify(detail.task ?? null, null, 2)}</pre>}
                {tab === 'events' && (
                  <pre>{detail.events.join('\n\n') || 'No events recorded.'}</pre>
                )}
              </>
            ) : (
              <div className="empty">
                {running
                  ? 'Waiting for this question to reach the model boundary…'
                  : 'Run a capture, then select a question to inspect its model request.'}
              </div>
            )}
          </div>
        </article>
      </main>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
