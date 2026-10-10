import { useCallback, useEffect, useState } from 'react'

type UsageSnapshot = Awaited<ReturnType<typeof window.ide.getUsageStats>>

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return String(n)
}

function niceModelName(model: string): string {
  if (model === 'builtin:composer-lite') return 'Composer Lite'
  if (model === 'builtin:composer') return 'Composer Full'
  if (model.startsWith('builtin:')) return model.replace(/^builtin:/, 'Composer ')
  return model
}

function kindAccent(kind: string): string {
  if (kind === 'builtin') return 'usage-accent-builtin'
  if (kind === 'openai-compatible') return 'usage-accent-api'
  return 'usage-accent-other'
}

export function UsagePanel() {
  const [stats, setStats] = useState<UsageSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setStats(await window.ide.getUsageStats())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const today = stats?.today
  const totalToday =
    (today?.totalInputTokens || 0) + (today?.totalOutputTokens || 0)
  const maxModel = Math.max(1, ...(stats?.byModel.map((m) => m.totalTokens) || [1]))
  const maxKind = Math.max(1, ...(stats?.byKind.map((k) => k.totalTokens) || [1]))
  const weekTotal = (stats?.days || []).reduce(
    (sum, d) => sum + d.totalInputTokens + d.totalOutputTokens,
    0
  )
  const weekMax = Math.max(
    1,
    ...(stats?.days || []).map((d) => d.totalInputTokens + d.totalOutputTokens)
  )

  return (
    <div className="usage-panel">
      <p className="subtitle" style={{ marginTop: 0 }}>
        Local accounting of model requests and estimated tokens (chars÷4 when providers don’t
        report usage). Resets per calendar day on this Mac.
      </p>

      <div className="usage-hero">
        <div className="usage-hero-card">
          <div className="usage-hero-label">Today</div>
          <div className="usage-hero-value">{formatTokens(totalToday)}</div>
          <div className="usage-hero-sub">tokens · {today?.totalRequests || 0} requests</div>
        </div>
        <div className="usage-hero-card">
          <div className="usage-hero-label">Input</div>
          <div className="usage-hero-value usage-tone-in">
            {formatTokens(today?.totalInputTokens || 0)}
          </div>
          <div className="usage-hero-sub">prompt tokens</div>
        </div>
        <div className="usage-hero-card">
          <div className="usage-hero-label">Output</div>
          <div className="usage-hero-value usage-tone-out">
            {formatTokens(today?.totalOutputTokens || 0)}
          </div>
          <div className="usage-hero-sub">completion tokens</div>
        </div>
        <div className="usage-hero-card">
          <div className="usage-hero-label">Last 7 days</div>
          <div className="usage-hero-value">{formatTokens(weekTotal)}</div>
          <div className="usage-hero-sub">tokens across sessions</div>
        </div>
      </div>

      <section className="usage-section">
        <div className="usage-section-head">
          <h3>By model type</h3>
          <span className="usage-muted">{today?.date || '—'}</span>
        </div>
        {(stats?.byKind.length || 0) === 0 ? (
          <div className="usage-empty">No model usage recorded today yet.</div>
        ) : (
          <div className="usage-bars">
            {stats!.byKind.map((k) => (
              <div key={k.kind} className="usage-bar-row">
                <div className="usage-bar-meta">
                  <span className="usage-bar-title">{k.label}</span>
                  <span className="usage-bar-stats">
                    {formatTokens(k.totalTokens)} · {k.requests} req · in{' '}
                    {formatTokens(k.inputTokens)} / out {formatTokens(k.outputTokens)}
                  </span>
                </div>
                <div className="usage-bar-track">
                  <div
                    className={`usage-bar-fill ${kindAccent(k.kind)}`}
                    style={{ width: `${Math.max(4, (k.totalTokens / maxKind) * 100)}%` }}
                  />
                </div>
                <div className="usage-bar-split">
                  <div
                    className="usage-bar-split-in"
                    style={{
                      width: `${
                        k.totalTokens
                          ? Math.max(2, (k.inputTokens / k.totalTokens) * 100)
                          : 0
                      }%`
                    }}
                    title={`Input ${formatTokens(k.inputTokens)}`}
                  />
                  <div
                    className="usage-bar-split-out"
                    style={{
                      width: `${
                        k.totalTokens
                          ? Math.max(2, (k.outputTokens / k.totalTokens) * 100)
                          : 0
                      }%`
                    }}
                    title={`Output ${formatTokens(k.outputTokens)}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h3>By model</h3>
          <div className="usage-legend">
            <span>
              <i className="usage-dot usage-dot-in" /> Input
            </span>
            <span>
              <i className="usage-dot usage-dot-out" /> Output
            </span>
          </div>
        </div>
        {(stats?.byModel.length || 0) === 0 ? (
          <div className="usage-empty">Chat with an agent or use inline AI to start a chart.</div>
        ) : (
          <div className="usage-bars">
            {stats!.byModel.map((m) => (
              <div key={`${m.kind}-${m.provider}-${m.model}`} className="usage-bar-row">
                <div className="usage-bar-meta">
                  <span className="usage-bar-title">
                    {niceModelName(m.model)}
                    <span className="usage-pill">{m.provider}</span>
                  </span>
                  <span className="usage-bar-stats">
                    {formatTokens(m.totalTokens)} total · {m.requests} req ·{' '}
                    {Math.round(m.share * 100)}%
                  </span>
                </div>
                <div className="usage-bar-track usage-bar-track-stack">
                  <div
                    className="usage-bar-fill usage-fill-in"
                    style={{
                      width: `${Math.max(2, (m.inputTokens / maxModel) * 100)}%`
                    }}
                  />
                  <div
                    className="usage-bar-fill usage-fill-out"
                    style={{
                      width: `${Math.max(2, (m.outputTokens / maxModel) * 100)}%`
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h3>Daily trend</h3>
          <span className="usage-muted">Last {(stats?.days.length || 0) || 7} days</span>
        </div>
        {(stats?.days.length || 0) === 0 ? (
          <div className="usage-empty">No history yet.</div>
        ) : (
          <div className="usage-trend">
            {[...(stats?.days || [])].reverse().map((d) => {
              const total = d.totalInputTokens + d.totalOutputTokens
              return (
                <div key={d.date} className="usage-trend-col" title={`${d.date}: ${total} tokens`}>
                  <div className="usage-trend-bar-wrap">
                    <div
                      className="usage-trend-bar"
                      style={{ height: `${Math.max(6, (total / weekMax) * 100)}%` }}
                    />
                  </div>
                  <div className="usage-trend-label">{d.date.slice(5)}</div>
                  <div className="usage-trend-value">{formatTokens(total)}</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <div className="model-conn-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (!window.confirm('Clear today’s usage counters?')) return
              setBusy(true)
              try {
                setStats(await window.ide.clearUsageStats({ todayOnly: true }))
              } finally {
                setBusy(false)
              }
            })()
          }
        >
          Clear today
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (!window.confirm('Clear all stored usage history on this Mac?')) return
              setBusy(true)
              try {
                setStats(await window.ide.clearUsageStats())
              } finally {
                setBusy(false)
              }
            })()
          }
        >
          Clear all
        </button>
      </div>
      {error && (
        <p className="model-conn-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
