import { useCallback, useEffect, useState } from 'react'
import type {
  UsageDayTotals,
  UsageEntitlement,
  UsageLimitMeter,
  UsageSnapshot,
  UsageSyncMeta
} from '@/shared/api'

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

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'never'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'never'
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return 'never'
  }
}

function syncLabel(sync: UsageSyncMeta | undefined, refreshing: boolean): string {
  if (refreshing || sync?.state === 'syncing') return 'Syncing…'
  if (!sync?.authenticated) return 'Sign in to sync account usage'
  if (sync.state === 'ok') return `Synced ${formatSyncTime(sync.lastSyncedAt)}`
  if (sync.state === 'offline') {
    return sync.lastError
      ? `Offline — ${sync.lastError}`
      : 'Offline — showing device totals until sync works'
  }
  if (sync.state === 'error') {
    return sync.lastError ? `Sync error — ${sync.lastError}` : 'Sync error'
  }
  return sync.lastSyncedAt
    ? `Last synced ${formatSyncTime(sync.lastSyncedAt)}`
    : 'Account sync idle'
}

type UsageDay = UsageSnapshot['days'][number]

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map((part) => Number(part))
  if (!y || !m || !d) return date
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

function chartsForDay(day: UsageDay | undefined): {
  byKind: UsageSnapshot['byKind']
  byModel: UsageSnapshot['byModel']
} {
  const models = Object.values(day?.models || {})
  const kindMap = new Map<
    UsageSnapshot['byKind'][number]['kind'],
    { requests: number; inputTokens: number; outputTokens: number }
  >()
  for (const entry of models) {
    const cur = kindMap.get(entry.kind) || { requests: 0, inputTokens: 0, outputTokens: 0 }
    cur.requests += entry.requests
    cur.inputTokens += entry.inputTokens
    cur.outputTokens += entry.outputTokens
    kindMap.set(entry.kind, cur)
  }
  const labels: Record<string, string> = {
    builtin: 'Built-in Composer',
    'openai-compatible': 'OpenAI-compatible',
    other: 'Other'
  }
  const byKind = (['builtin', 'openai-compatible', 'other'] as const)
    .map((kind) => {
      const cur = kindMap.get(kind) || { requests: 0, inputTokens: 0, outputTokens: 0 }
      return {
        kind,
        label: labels[kind] || kind,
        ...cur,
        totalTokens: cur.inputTokens + cur.outputTokens
      }
    })
    .filter((row) => row.totalTokens > 0 || row.requests > 0)
  const total = models.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0)
  const byModel = models
    .map((entry) => {
      const totalTokens = entry.inputTokens + entry.outputTokens
      return { ...entry, totalTokens, share: total > 0 ? totalTokens / total : 0 }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
  return { byKind, byModel }
}

function totalsLine(t: UsageDayTotals | null | undefined): string {
  if (!t) return '—'
  const tokens = t.inputTokens + t.outputTokens
  return `${t.requests} req · ${formatTokens(tokens)} tok · ${t.cloudJobs} cloud`
}

function LimitMeter({
  label,
  meter,
  format = (n) => String(n)
}: {
  label: string
  meter: UsageLimitMeter
  format?: (n: number) => string
}) {
  const unlimited = meter.limit == null
  const pct = unlimited ? 0 : Math.round(meter.ratio * 100)
  return (
    <div className={`usage-limit-meter${meter.exhausted ? ' is-exhausted' : ''}`}>
      <div className="usage-limit-meter-head">
        <span>{label}</span>
        <span className="usage-muted">
          {unlimited
            ? `${format(meter.used)} · unlimited`
            : `${format(meter.used)} / ${format(meter.limit!)}`}
        </span>
      </div>
      <div className="usage-bar-track">
        <div
          className={`usage-bar-fill ${meter.exhausted ? 'usage-accent-other' : 'usage-accent-builtin'}`}
          style={{ width: unlimited ? '8%' : `${Math.max(meter.used > 0 ? 4 : 0, pct)}%` }}
        />
      </div>
    </div>
  )
}

export function UsagePanel() {
  const [stats, setStats] = useState<UsageSnapshot | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // Refresh account plan from Control Hub when signed in
      try {
        await window.ide.ericServicesStatus()
      } catch {
        /* offline / signed out — local Free caps still apply */
      }
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
  const ent: UsageEntitlement | undefined = stats?.entitlement
  const profile = stats?.profile
  const sync = profile?.sync
  const isPro = ent?.plan === 'pro'
  const syncing = busy || sync?.state === 'syncing'
  const windowTotals = profile?.effectiveWindow || stats?.window
  const windowTokens = (windowTotals?.inputTokens || 0) + (windowTotals?.outputTokens || 0)
  const windowDays = stats?.window?.days || ent?.window?.days || stats?.days.length || 30
  const windowRange =
    stats?.window?.from && stats?.window?.to
      ? `${dayLabel(stats.window.from)} – ${dayLabel(stats.window.to)}`
      : `Last ${windowDays} days`
  const focus =
    stats?.days.find((day) => day.date === selectedDate) ||
    stats?.days.find((day) => day.date === today?.date) ||
    today
  const focusCharts = chartsForDay(focus)
  const focusTokens = (focus?.totalInputTokens || 0) + (focus?.totalOutputTokens || 0)
  const maxModel = Math.max(1, ...focusCharts.byModel.map((m) => m.totalTokens), 1)
  const maxKind = Math.max(1, ...focusCharts.byKind.map((k) => k.totalTokens), 1)
  const trendMax = Math.max(
    1,
    ...(stats?.days || []).map((d) => d.totalInputTokens + d.totalOutputTokens)
  )

  return (
    <div className="usage-panel">
      {ent?.authenticated && (
        <div className={`usage-sync-card${syncing ? ' is-syncing' : ''}`}>
          <div className="usage-sync-head">
            <strong>Account usage</strong>
            <span className="usage-sync-status">{syncLabel(sync, busy)}</span>
          </div>
          <p className="usage-sync-copy">
            Free limits use the last {windowDays} days. Each day counts the higher of this device
            and your EricServic.es profile, so multi-device use stays honest.
          </p>
          <div className="usage-sync-grid">
            <div className="usage-sync-cell">
              <div className="usage-sync-cell-label">This device · {windowDays}d</div>
              <div className="usage-sync-cell-value">
                {totalsLine(profile?.deviceWindow)}
              </div>
            </div>
            <div className="usage-sync-cell">
              <div className="usage-sync-cell-label">Account · {windowDays}d</div>
              <div className="usage-sync-cell-value">
                {syncing && !profile?.accountWindow
                  ? 'Syncing…'
                  : totalsLine(profile?.accountWindow)}
              </div>
            </div>
            <div className="usage-sync-cell is-effective">
              <div className="usage-sync-cell-label">Counted toward limits</div>
              <div className="usage-sync-cell-value">
                {totalsLine(profile?.effectiveWindow)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={`usage-plan-banner${isPro ? ' is-pro' : ' is-free'}`}>
        <div className="usage-plan-banner-main">
          <div className="usage-plan-badge">{ent?.planLabel || 'Free'}</div>
          <div>
            <div className="usage-plan-title">
              {isPro ? 'Pro — unlimited usage' : `Free plan — last ${windowDays} days`}
            </div>
            <p className="usage-plan-copy">
              {ent?.authenticated
                ? isPro
                  ? 'Your EricServic.es account is on Pro. Plan is managed in the Control Hub.'
                  : `Limits apply to a rolling ${windowDays}-day window (${windowRange}). An admin can upgrade your account to Pro on www.ericservic.es.`
                : `Sign in under Settings → Account to sync your plan from EricServic.es. Until then, Free limits apply to the last ${windowDays} days.`}
            </p>
          </div>
        </div>
        <div className="usage-plan-actions">
          {!isPro && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void window.ide.ericServicesOpenUpgrade()}
            >
              Upgrade to Pro
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void window.ide.ericServicesOpenAccount()}
          >
            {ent?.authenticated ? 'Manage account' : 'Sign in'}
          </button>
        </div>
      </div>

      {ent?.blockedReason && (
        <div className="usage-limit-alert">
          {ent.blockedReason}
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
            onClick={() => void window.ide.ericServicesOpenUpgrade()}
          >
            Upgrade to Pro
          </button>
        </div>
      )}

      {ent && (
        <section className="usage-section">
          <div className="usage-section-head">
            <h3>Allowance</h3>
            <span className="usage-muted">{windowRange}</span>
          </div>
          <div className="usage-limit-grid">
            <LimitMeter label="Requests" meter={ent.requests} />
            <LimitMeter label="Tokens" meter={ent.tokens} format={formatTokens} />
            <LimitMeter label="Cloud Agent jobs" meter={ent.cloudJobs} />
          </div>
        </section>
      )}

      <p className="subtitle" style={{ marginTop: 0 }}>
        Allowance meters use the last {windowDays} days. Pick a day to see that day’s model
        breakdown on this device (chars÷4 when providers don’t report usage).
      </p>

      <div className="usage-hero">
        <div className="usage-hero-card">
          <div className="usage-hero-label">Last {windowDays} days</div>
          <div className="usage-hero-value">{formatTokens(windowTokens)}</div>
          <div className="usage-hero-sub">
            tokens · {windowTotals?.requests || 0} requests · {windowTotals?.cloudJobs || 0} cloud
          </div>
        </div>
        <div className="usage-hero-card">
          <div className="usage-hero-label">{focus ? dayLabel(focus.date) : 'Day'}</div>
          <div className="usage-hero-value">{formatTokens(focusTokens)}</div>
          <div className="usage-hero-sub">tokens · {focus?.totalRequests || 0} requests</div>
        </div>
        <div className="usage-hero-card">
          <div className="usage-hero-label">Input</div>
          <div className="usage-hero-value usage-tone-in">
            {formatTokens(focus?.totalInputTokens || 0)}
          </div>
          <div className="usage-hero-sub">prompt tokens that day</div>
        </div>
        <div className="usage-hero-card">
          <div className="usage-hero-label">Output</div>
          <div className="usage-hero-value usage-tone-out">
            {formatTokens(focus?.totalOutputTokens || 0)}
          </div>
          <div className="usage-hero-sub">completion tokens that day</div>
        </div>
      </div>

      <section className="usage-section">
        <div className="usage-section-head">
          <h3>By model type</h3>
          <span className="usage-muted">{focus ? dayLabel(focus.date) : '—'}</span>
        </div>
        {focusCharts.byKind.length === 0 ? (
          <div className="usage-empty">
            {focusTokens > 0
              ? 'No per-model breakdown for this day.'
              : 'No model usage recorded for this day.'}
          </div>
        ) : (
          <div className="usage-bars">
            {focusCharts.byKind.map((k) => (
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
        {focusCharts.byModel.length === 0 ? (
          <div className="usage-empty">No model usage recorded for this day.</div>
        ) : (
          <div className="usage-bars">
            {focusCharts.byModel.map((m) => (
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
          <h3>Daily usage</h3>
          <label className="usage-day-picker">
            <span className="usage-muted">Day</span>
            <select
              value={focus?.date || ''}
              onChange={(event) => setSelectedDate(event.target.value)}
            >
              {(stats?.days || []).map((day) => (
                <option key={day.date} value={day.date}>
                  {dayLabel(day.date)} ·{' '}
                  {formatTokens(day.totalInputTokens + day.totalOutputTokens)} tok · {day.totalRequests}{' '}
                  req
                </option>
              ))}
            </select>
          </label>
        </div>
        {(stats?.days.length || 0) === 0 ? (
          <div className="usage-empty">No history yet.</div>
        ) : (
          <div className="usage-trend" role="listbox" aria-label="Usage by day">
            {[...(stats?.days || [])].reverse().map((d) => {
              const total = d.totalInputTokens + d.totalOutputTokens
              const selected = d.date === focus?.date
              return (
                <button
                  key={d.date}
                  type="button"
                  className={`usage-trend-col${selected ? ' is-selected' : ''}`}
                  title={`${dayLabel(d.date)}: ${formatTokens(total)} tokens, ${d.totalRequests} requests, ${d.cloudJobs || 0} cloud jobs`}
                  aria-pressed={selected}
                  onClick={() => setSelectedDate(d.date)}
                >
                  <div className="usage-trend-bar-wrap">
                    <div
                      className="usage-trend-bar"
                      style={{ height: `${Math.max(total > 0 ? 8 : 4, (total / trendMax) * 100)}%` }}
                    />
                  </div>
                  <div className="usage-trend-label">{d.date.slice(8)}</div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <div className="model-conn-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          {syncing ? 'Syncing…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (!window.confirm('Clear today’s usage counters on this device?')) return
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
              if (!window.confirm('Clear all stored usage history on this device?')) return
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
