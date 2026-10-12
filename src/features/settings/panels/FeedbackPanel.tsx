import { useCallback, useEffect, useState } from 'react'
import { BugReportForm } from '@/features/feedback/BugReportForm'
import type { FeedbackHistoryItem } from '@/shared/api'
import { SettingsPage, SettingsSection } from '../SettingsSection'

function formatWhen(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(ms))
}

export function FeedbackPanel() {
  const [history, setHistory] = useState<FeedbackHistoryItem[]>([])
  const [historyKey, setHistoryKey] = useState(0)

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await window.ide.listFeedbackHistory())
    } catch {
      setHistory([])
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory, historyKey])

  return (
    <SettingsPage className="feedback-page">
      <SettingsSection
        title="Send feedback"
        description="Tell us what broke, what would help, or what you’re stuck on. Optional diagnostics are included — no GitHub account required."
      >
        <BugReportForm
          variant="page"
          onSubmitted={() => setHistoryKey((k) => k + 1)}
        />
      </SettingsSection>

      <SettingsSection
        title="Recent submissions"
        description="Filed from this Mac. Numbers match Eris-feedback issues."
        actions={
          <button type="button" className="btn" onClick={() => void refreshHistory()}>
            Refresh
          </button>
        }
      >
        {history.length === 0 ? (
          <p className="settings-empty">No submissions yet from this install.</p>
        ) : (
          <ul className="feedback-history-list">
            {history.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {typeof item.number === 'number' ? `#${item.number} · ` : ''}
                    {item.title}
                  </strong>
                  <span>
                    {formatWhen(item.submittedAt)}
                    {item.via ? ` · ${item.via}` : ''}
                  </span>
                </div>
                {item.htmlUrl ? (
                  <code className="feedback-history-url" title={item.htmlUrl}>
                    {item.htmlUrl.replace(/^https:\/\/github\.com\//, '')}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}
