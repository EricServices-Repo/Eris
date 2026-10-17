import { useEffect, useMemo, useRef, useState } from 'react'
import { summarizeThinkingSteps, thinkingPreviewLine } from './thinking-summary'

export interface ToolActivityItem {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  detail: string
}

interface Props {
  thinking: string
  status?: string | null
  tools?: ToolActivityItem[]
  /** When true, default expanded; when false (saved messages), default collapsed */
  defaultOpen?: boolean
  live?: boolean
}

const MAX_VISIBLE_TOOLS = 5

export function ThinkingBlock({
  thinking,
  status,
  tools = [],
  defaultOpen = false,
  live = false
}: Props) {
  // Live: keep the compact panel open. Historical: collapsed by default.
  const [open, setOpen] = useState(defaultOpen || live)
  const [showLog, setShowLog] = useState(false)
  const liveRef = useRef<HTMLPreElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const hasTools = tools.length > 0
  const hasThinking = Boolean(thinking.trim())

  const steps = useMemo(() => summarizeThinkingSteps(thinking), [thinking])
  const preview = useMemo(
    () => thinkingPreviewLine(thinking, status, tools),
    [thinking, status, tools]
  )
  const recentTools = useMemo(() => tools.slice(-MAX_VISIBLE_TOOLS), [tools])
  const hiddenToolCount = Math.max(0, tools.length - recentTools.length)

  useEffect(() => {
    if (live) setOpen(true)
    else if (!defaultOpen) setOpen(false)
  }, [live, defaultOpen])

  useEffect(() => {
    if (!live || !open || !liveRef.current) return
    liveRef.current.scrollTop = liveRef.current.scrollHeight
  }, [thinking, status, tools, open, live])

  useEffect(() => {
    if (!showLog || !live || !logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [thinking, showLog, live])

  if (!hasThinking && !hasTools) return null

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
        {steps.length > 0 && !live && (
          <span className="thinking-step-count">{steps.length}</span>
        )}
      </button>

      {open && (
        <div className="thinking-body">
          {hasTools && (
            <div className="tool-activity">
              {hiddenToolCount > 0 && (
                <div className="tool-status">+{hiddenToolCount} earlier</div>
              )}
              {recentTools.map((t) => (
                <div key={t.id} className={`tool-row tool-${t.status}`}>
                  <span className="tool-name">{t.name}</span>
                  {t.path && (
                    <span className="tool-path" title={t.path}>
                      {t.path}
                    </span>
                  )}
                  <span className="tool-state">{t.status === 'ok' ? 'done' : t.status}</span>
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

          {/* Live: stream the raw thinking so progress is visible while the model runs. */}
          {live && (
            <pre ref={liveRef} className="thinking-text thinking-text-live">
              {hasThinking ? thinking : status?.trim() || 'Working…'}
            </pre>
          )}

          {!live && !steps.length && !hasTools && (
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
