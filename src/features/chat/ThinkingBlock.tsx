import { useEffect, useRef, useState } from 'react'

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

export function ThinkingBlock({
  thinking,
  status,
  tools = [],
  defaultOpen = false,
  live = false
}: Props) {
  const [open, setOpen] = useState(defaultOpen || live)
  const bodyRef = useRef<HTMLPreElement>(null)
  const hasTools = tools.length > 0
  const hasBody = Boolean(thinking.trim() || status || hasTools)

  useEffect(() => {
    if (live) setOpen(true)
    else if (!defaultOpen) setOpen(false)
  }, [live, defaultOpen])

  useEffect(() => {
    if (!open || !live || !bodyRef.current) return
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [thinking, open, live, tools, status])

  if (!hasBody && !live) return null

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
        {status && <span className="thinking-status-inline">{status}</span>}
        {!open && thinking.trim() && (
          <span className="thinking-preview">{thinking.trim().slice(-80)}</span>
        )}
      </button>
      {open && (
        <div className="thinking-body">
          {hasTools && (
            <div className="tool-activity">
              {tools.map((t) => (
                <div key={t.id} className={`tool-row tool-${t.status}`}>
                  <span className="tool-name">{t.name}</span>
                  {t.path && <span className="tool-path">{t.path}</span>}
                  <span className="tool-state">{t.status}</span>
                </div>
              ))}
            </div>
          )}
          <pre ref={bodyRef} className="thinking-text">
            {thinking || (live ? '…' : '')}
          </pre>
        </div>
      )}
    </div>
  )
}
