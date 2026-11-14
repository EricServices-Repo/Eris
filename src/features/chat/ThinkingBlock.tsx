import { useEffect, useMemo, useRef, useState } from 'react'
import { reasoningPreviewLine, summarizeThinkingSteps, thinkingPreviewLine } from './thinking-summary'

export interface ToolActivityItem {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  effect?: 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
  changedResources?: string[]
  durationMs?: number
  failure?: { code: string; retryable: boolean }
  detail: string
}

interface Props {
  thinking: string
  /** The model's own reasoning (#573), shown apart from Eris's tool progress. */
  reasoning?: string
  status?: string | null
  tools?: ToolActivityItem[]
  /** When true, default expanded; when false (saved messages), default collapsed */
  defaultOpen?: boolean
  live?: boolean
}

const MAX_VISIBLE_TOOLS = 5

export function ThinkingBlock({
  thinking,
  reasoning = '',
  status,
  tools = [],
  defaultOpen = false,
  live = false
}: Props) {
  // Progress remains visible in the summary; tool logs are opened on demand.
  const [open, setOpen] = useState(defaultOpen)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const reasoningRef = useRef<HTMLPreElement>(null)
  // Live reasoning is shown as it arrives; saved reasoning waits to be opened.
  const [showReasoning, setShowReasoning] = useState(live)
  const [copied, setCopied] = useState(false)
  const hasTools = tools.length > 0
  const hasThinking = Boolean(thinking.trim())
  const hasReasoning = Boolean(reasoning.trim())

  const steps = useMemo(() => summarizeThinkingSteps(thinking), [thinking])
  const preview = useMemo(() => {
    const progress = thinkingPreviewLine(thinking, status, tools)
    // While the model reasons and Eris has nothing newer to report, show the reasoning.
    if (live && hasReasoning && !tools.some((t) => t.status === 'running') && !summarizeThinkingSteps(thinking).length)
      return reasoningPreviewLine(reasoning) || progress
    return progress
  }, [thinking, status, tools, live, hasReasoning, reasoning])
  const recentTools = useMemo(() => tools.slice(-MAX_VISIBLE_TOOLS), [tools])
  const hiddenToolCount = Math.max(0, tools.length - recentTools.length)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  useEffect(() => {
    if (!showLog || !live || !logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [thinking, showLog, live])

  useEffect(() => {
    if (!showReasoning || !live || !reasoningRef.current) return
    reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight
  }, [reasoning, showReasoning, live])

  const copyReasoning = () => {
    void navigator.clipboard?.writeText(reasoning).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => undefined
    )
  }

  if (!hasThinking && !hasTools && !hasReasoning && !status?.trim()) return null

  return (
    <div className={`thinking-block ${open ? 'open' : ''} ${live ? 'live' : ''}`}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="thinking-carrot">{open ? '▾' : '▸'}</span>
        <span className="thinking-label">
          Thinking
          {live && <span className="thinking-live-dot" aria-hidden />}
        </span>
        {status?.trim() && (
          <span className="thinking-status-inline" title={status}>
            {status.trim()}
          </span>
        )}
        {preview && preview !== status?.trim() ? (
          <span className="thinking-preview" title={preview}>
            {preview}
          </span>
        ) : live && !status?.trim() ? (
          <span className="thinking-preview">Working…</span>
        ) : null}
        {steps.length > 0 && !live && <span className="thinking-step-count">{steps.length}</span>}
      </button>

      {open && (
        <div className="thinking-body">
          {hasTools && (
            <div className="tool-activity">
              {hiddenToolCount > 0 && <div className="tool-status">+{hiddenToolCount} earlier</div>}
              {recentTools.map((t) => (
                <div
                  key={t.id}
                  className={`tool-row tool-${t.status}`}
                  title={[
                    t.detail,
                    t.effect ? `Effect: ${t.effect}` : '',
                    t.failure
                      ? `Failure: ${t.failure.code}${t.failure.retryable ? ' (retryable)' : ''}`
                      : '',
                    t.durationMs != null ? `${t.durationMs} ms` : ''
                  ]
                    .filter(Boolean)
                    .join('\n')}
                >
                  <span className="tool-name">{t.name}</span>
                  {t.path && (
                    <span className="tool-path" title={t.path}>
                      {t.path}
                    </span>
                  )}
                  <span className="tool-state">
                    {t.status === 'ok' ? 'done' : t.status}
                    {t.effect && t.effect !== 'read' ? ` · ${t.effect}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {steps.length > 0 && (
            <ul className="thinking-steps">
              {steps.map((s, i) => (
                <li key={`${i}-${s.slice(0, 24)}`}>{s}</li>
              ))}
            </ul>
          )}

          {hasReasoning && (
            <div className="thinking-reasoning">
              <div className="thinking-reasoning-head">
                <button
                  type="button"
                  className="thinking-log-toggle"
                  onClick={() => setShowReasoning((v) => !v)}
                  aria-expanded={showReasoning}
                >
                  {showReasoning ? '▾' : '▸'} Model reasoning
                </button>
                {showReasoning && (
                  <button type="button" className="thinking-log-toggle" onClick={copyReasoning}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              {showReasoning && (
                <pre ref={reasoningRef} className="thinking-reasoning-text">
                  {reasoning}
                </pre>
              )}
            </div>
          )}

          {!live && !steps.length && !hasTools && !hasReasoning && (
            <div className="thinking-idle">No activity recorded.</div>
          )}

          {!live && hasThinking && (
            <div className="thinking-log-wrap">
              <button
                type="button"
                className="thinking-log-toggle"
                onClick={() => setShowLog((v) => !v)}
                aria-expanded={showLog}
              >
                {showLog ? 'Hide log' : 'Log'}
              </button>
              {showLog && (
                <pre ref={logRef} className="thinking-text">
                  {thinking}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
