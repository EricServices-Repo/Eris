import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DevApi, DevResult, DevSummary } from '../shared/eris-dev'
import './style.css'
declare global {
  interface Window {
    erisDev: DevApi
  }
}
function App() {
  const [questions, setQuestions] = useState<string[]>([])
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
  const [tab, setTab] = useState<'messages' | 'tools' | 'contract' | 'events'>('messages')
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
  return (
    <div className="app">
      <header>
        <div>
          <span className="logo">E</span>
          <strong>Eris-Dev</strong>
          <span className="badge">Agent request inspector</span>
        </div>
        <span className="muted">Local capture · no model inference</span>
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
                  setName(file.name)
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
                  await window.erisDev.start({ context, mode })
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
        <p className="hint">
          Each question is an independent turn. A selected project is copied into a temporary
          workspace; hidden folders and build dependencies are excluded. Intent-model requests use a
          labelled fallback response. Agent capture stops before inference or tool execution.
          Exports include prompt/source text.
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
            {questions.slice(page * 100, page * 100 + 100).map((question, offset) => {
              const index = page * 100 + offset
              const result = results[index]
              return (
                <button
                  key={index}
                  className={`question ${selected === index ? 'selected' : ''}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="number">{index + 1}</span>
                  <span>
                    <span className="question-text">{question}</span>
                    <small className={result?.status}>
                      {result
                        ? `${result.status} · ${result.agent ?? 'no agent'} · ${result.intent ?? 'unresolved'}`
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
            <h2>{questions[selected] ?? 'Model request preview'}</h2>
            {detail && (
              <p>
                {detail.status} · {detail.durationMs} ms · {detail.calls} requests
              </p>
            )}
          </div>
          <nav>
            {(['messages', 'tools', 'contract', 'events'] as const).map((value) => (
              <button
                key={value}
                className={tab === value ? 'active' : ''}
                onClick={() => setTab(value)}
              >
                {value}
              </button>
            ))}
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
