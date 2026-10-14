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
      {ent?.authenticated && (
        <div className={`usage-sync-card${syncing ? ' is-syncing' : ''}`}>
          <div className="usage-sync-head">
            <strong>Account usage</strong>
            <span className="usage-sync-status">{syncLabel(sync, busy)}</span>
          </div>
          <p className="usage-sync-copy">
            Free daily caps use the higher of this device and your EricServic.es profile, so
            multi-device use stays honest.
          </p>
          <div className="usage-sync-grid">
            <div className="usage-sync-cell">
              <div className="usage-sync-cell-label">This device</div>
              <div className="usage-sync-cell-value">
                {totalsLine(profile?.deviceToday)}
              </div>
            </div>
            <div className="usage-sync-cell">
              <div className="usage-sync-cell-label">Account (profile)</div>
              <div className="usage-sync-cell-value">
                {syncing && !profile?.accountToday
                  ? 'Syncing…'
                  : totalsLine(profile?.accountToday)}
              </div>
            </div>
            <div className="usage-sync-cell is-effective">
              <div className="usage-sync-cell-label">Counted toward Free caps</div>
              <div className="usage-sync-cell-value">
                {totalsLine(profile?.effectiveToday)}
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
              {isPro ? 'Pro — unlimited usage' : 'Free plan — daily limits apply'}
            </div>
            <p className="usage-plan-copy">
              {ent?.authenticated
                ? isPro
                  ? 'Your EricServic.es account is on Pro. Plan is managed in the Control Hub.'
                  : 'Limits reset each calendar day. An admin can upgrade your account to Pro on www.ericservic.es.'
                : 'Sign in under Settings → Account to sync your plan from EricServic.es. Until then, Free limits apply.'}
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
            <h3>Today’s allowance</h3>
            <span className="usage-muted">{today?.date || '—'}</span>
          </div>
          <div className="usage-limit-grid">
            <LimitMeter label="Requests" meter={ent.requests} />
            <LimitMeter label="Tokens" meter={ent.tokens} format={formatTokens} />
            <LimitMeter label="Cloud Agent jobs" meter={ent.cloudJobs} />
          </div>
        </section>
      )}

      <p className="subtitle" style={{ marginTop: 0 }}>
        Charts below are this device’s model breakdown (chars÷4 when providers don’t report
        usage). Allowance meters above use account-aware Free caps when signed in.
      </p>

      <div className="usage-hero">
        <div className="usage-hero-card">
          <div className="usage-hero-label">Today (device)</div>
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
