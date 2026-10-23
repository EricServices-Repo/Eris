import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  DevApi,
  DevImportPreview,
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
  const summaries = Object.values(results)
  const captures = summaries.filter((item) => item.status === 'captured').length
  const withDefects = summaries.filter((item) => item.findings.defect > 0).length
  const forReview = summaries.filter(
    (item) => !item.findings.defect && item.findings.review > 0
  ).length
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
                const path = await window.erisDev.exportRun()
                if (path) setNotice(`Exported to ${path}`)
              })
            }
          >
            Export JSONL
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
            Questions <span>{questions.length.toLocaleString()}</span>
          </div>
          <div className="list">
            {questions.slice(page * 100, page * 100 + 100).map((entry, offset) => {
              const index = page * 100 + offset
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
              {page + 1} / {Math.max(1, Math.ceil(questions.length / 100))}
            </span>
            <button
              disabled={(page + 1) * 100 >= questions.length}
              onClick={() => setPage(page + 1)}
            >
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
