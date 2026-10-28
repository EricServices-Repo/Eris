import { useDialogFocus } from '@/hooks/useDialogFocus'
import { useState } from 'react'
import type { ChatMessage } from '@/shared/settings-schema'
import { BugReportForm } from '@/features/feedback/BugReportForm'

function clip(text: string, max = 12_000): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n\n[truncated]`
}

function feedbackDraft(
  question: string,
  message: ChatMessage
): { title: string; description: string } {
  const asked = clip(question || '(no question text)')
  const titleSource = asked.replace(/\s+/g, ' ')
  const title = `Bad answer: ${titleSource.slice(0, 120)}`
  const description = [
    '## Question',
    '',
    asked,
    '',
    '## Thinking',
    '',
    clip(message.thinking || '(no thinking trace)'),
    '',
    '## Answer',
    '',
    clip(message.content || '(empty answer)'),
    '',
    '## Environment',
    '',
    [
      message.agentName ? `Agent: ${message.agentName}` : '',
      message.model ? `Model: ${message.model}` : ''
    ]
      .filter(Boolean)
      .join('\n') || '(agent and model were not recorded)',
    '',
    '_App, OS, and workspace details are attached with this report._'
  ].join('\n')
  return { title, description }
}

export function AnswerFeedback({ message, question }: { message: ChatMessage; question: string }) {
  const dialogRef = useDialogFocus(() => setOpen(false))
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  const [open, setOpen] = useState(false)
  const draft = feedbackDraft(question, message)

  return (
    <>
      <div className="msg-feedback" role="group" aria-label="Rate this answer">
        <button
          type="button"
          className={`msg-feedback-btn${vote === 'up' ? ' is-on' : ''}`}
          aria-pressed={vote === 'up'}
          title="Good answer"
          onClick={() => {
            setVote('up')
            setOpen(false)
          }}
        >
          <ThumbUp />
        </button>
        <button
          type="button"
          className={`msg-feedback-btn${vote === 'down' ? ' is-on' : ''}`}
          aria-pressed={vote === 'down'}
          title="Bad answer — send feedback"
          onClick={() => {
            setVote('down')
            setOpen(true)
          }}
        >
          <ThumbDown />
        </button>
      </div>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal bug-report-modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Send feedback"
            tabIndex={-1}
            aria-labelledby="answer-feedback-title"
            style={{
              width: 'min(560px, 94vw)',
              height: 'auto',
              maxHeight: 'min(88vh, 760px)',
              gridTemplateColumns: '1fr',
              padding: 0,
              display: 'flex',
              flexDirection: 'column'
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ padding: '18px 20px 4px' }}>
              <h2 id="answer-feedback-title" style={{ margin: '0 0 4px', fontSize: 18 }}>
                Send feedback
              </h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                This answer, the question, the thinking trace, and this Mac’s environment are filled
                in. Edit anything, then submit.
              </p>
            </div>
            <div style={{ padding: '4px 20px 16px', overflow: 'auto', flex: 1, minHeight: 0 }}>
              <BugReportForm
                key={message.id}
                variant="modal"
                initialKind="bug"
                initialTitle={draft.title}
                initialDescription={draft.description}
                initialIncludeLogs={false}
                initialIncludeDiagnostics
                onClose={() => setOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ThumbUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2 10h4v12H2V10zm20 1.2c0-.7-.5-1.2-1.2-1.2h-6.3l.9-4.4c.1-.6-.1-1.2-.6-1.6L14 3 7.6 9.4C7.2 9.8 7 10.3 7 10.8V20c0 1.1.9 2 2 2h9.1c.9 0 1.7-.6 1.9-1.4l2-7.2c.1-.2.1-.4.1-.6v-1.6z"
      />
    </svg>
  )
}

function ThumbDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M22 14h-4V2h4v12zM2 12.8c0 .7.5 1.2 1.2 1.2h6.3l-.9 4.4c-.1.6.1 1.2.6 1.6L10 21l6.4-6.4c.4-.4.6-.9.6-1.4V4c0-1.1-.9-2-2-2H5.9c-.9 0-1.7.6-1.9 1.4l-2 7.2c-.1.2-.1.4-.1.6v1.6z"
      />
    </svg>
  )
}
