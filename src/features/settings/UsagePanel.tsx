import { useCallback, useEffect, useState } from 'react'
import type { UsageDestination, UsageSnapshot } from '@/shared/api'
import { isErisCloudModelRef, type ErisHostedModels } from '@/shared/eris-cloud'
import { ERIS_CLOUD_WEEKLY_TOKEN_LIMIT } from '@/shared/eris-plan'
import { isNativeGgufRef } from '@/shared/model-destination'
import './weekly-usage.css'

const destinations = [
  { id: 'cloud', label: 'Eris Cloud' },
  { id: 'local', label: 'Local' },
  { id: 'external', label: 'Other providers' },
  { id: 'unclassified', label: 'Unclassified' }
] as const

type Destination = UsageDestination | 'unclassified'
const numberFormat = new Intl.NumberFormat()
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

function displayDate(key: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, options)
}

function dayUsage(day: UsageSnapshot['days'][number]) {
  const split: Record<Destination, number> = { cloud: 0, local: 0, external: 0, unclassified: 0 }
  const total = day.totalInputTokens + day.totalOutputTokens

  for (const entry of Object.values(day.models ?? {})) {
    let destination: Destination = entry.destination ?? 'unclassified'
    if (!entry.destination) {
      if (isErisCloudModelRef(entry.model)) destination = 'cloud'
      else if (entry.kind === 'builtin' || isNativeGgufRef(entry.model)) destination = 'local'
    }
    split[destination] += entry.inputTokens + entry.outputTokens
  }
  const attributed = Object.values(split).reduce((sum, tokens) => sum + tokens, 0)
  split.unclassified += Math.max(0, total - attributed)
  return { ...day, split, total }
}

export function UsagePanel() {
  const [stats, setStats] = useState<UsageSnapshot | null>(null)
  const [hostedAllowance, setHostedAllowance] = useState<ErisHostedModels['allowance']>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const account = await window.ide.ericServicesStatus().catch(() => undefined)
      setHostedAllowance(account?.ok && account.linked ? account.hostedAllowance : undefined)
      setStats(await window.ide.getUsageStats(7, { refresh: false }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function clearHistory(todayOnly: boolean) {
    const range = todayOnly ? 'today’s' : 'all'
    if (!window.confirm(`Clear ${range} usage history on this device?`)) return
    setBusy(true)
    setError(null)
    try {
      const snapshot = await window.ide.clearUsageStats({ todayOnly })
      setStats((previous) => ({
        ...snapshot,
        days: snapshot.days.slice(0, 7),
        entitlement: previous?.entitlement
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear usage')
    } finally {
      setBusy(false)
    }
  }

  const days = [...(stats?.days ?? [])].reverse().map(dayUsage)
  const split = days.reduce(
    (sum, day) => {
      for (const { id } of destinations) sum[id] += day.split[id]
      return sum
    },
    { cloud: 0, local: 0, external: 0, unclassified: 0 }
  )
  const total = Object.values(split).reduce((sum, tokens) => sum + tokens, 0)
  const requests = days.reduce((sum, day) => sum + day.totalRequests, 0)
  const peak = Math.max(
    1,
    ...days.map((day) => Object.values(day.split).reduce((sum, n) => sum + n, 0))
  )
  const visibleDestinations = destinations.filter(
    ({ id }) => id === 'cloud' || id === 'local' || split[id] > 0
  )
  const entitlement = stats?.entitlement
  const dateOptions = { month: 'short', day: 'numeric' } as const
  const firstDay = days[0]
  const lastDay = days[days.length - 1]

  return (
    <div className="usage-panel weekly-usage">
      <header className="weekly-usage-header">
        <div>
          <h2>Weekly usage</h2>
          <p className="usage-muted">
            Last 7 days on this device
            {firstDay &&
              lastDay &&
              ` · ${displayDate(firstDay.date, dateOptions)} – ${displayDate(lastDay.date, dateOptions)}`}
          </p>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && (
        <p role="alert" className="usage-limit-alert">
          {error}
        </p>
      )}
      {stats && (
        <section className="usage-section weekly-usage-summary" aria-label="Weekly model usage">
          <div className="weekly-usage-total">
            <strong title={numberFormat.format(total)}>{compactFormat.format(total)}</strong>
            <span>tokens</span>
            <span className="usage-muted">{numberFormat.format(requests)} model requests</span>
          </div>
          <div className="weekly-usage-stack" aria-hidden="true">
            {visibleDestinations.map(({ id }) => (
              <span
                key={id}
                data-destination={id}
                style={{ flexBasis: total ? `${(split[id] / total) * 100}%` : '0%' }}
              />
            ))}
          </div>
          <dl className="weekly-usage-legend">
            {visibleDestinations.map(({ id, label }) => (
              <div key={id}>
                <dt>
                  <i data-destination={id} />
                  {label}
                </dt>
                <dd title={numberFormat.format(split[id])}>
                  {compactFormat.format(split[id])} tokens
                </dd>
              </div>
            ))}
          </dl>

          {total > 0 ? (
            <div className="weekly-usage-days" aria-label="Daily token totals">
              {days.map((day) => (
                <div key={day.date} className="weekly-usage-day">
                  <div className="weekly-usage-column" aria-hidden="true">
                    {visibleDestinations.map(({ id }) => (
                      <span
                        key={id}
                        data-destination={id}
                        style={{ height: `${(day.split[id] / peak) * 100}%` }}
                      />
                    ))}
                  </div>
                  <span
                    title={`${displayDate(day.date, dateOptions)} · ${numberFormat.format(day.total)} tokens`}
                  >
                    {displayDate(day.date, { weekday: 'short' })}
                    <span className="weekly-usage-sr-only">
                      , {numberFormat.format(day.total)} tokens
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="usage-muted">No model usage recorded in the last 7 days.</p>
          )}
          <p className="usage-muted weekly-usage-footnote">
            {split.unclassified > 0
              ? 'Token counts may include estimates. Some older records lack provider location.'
              : 'Token counts may include estimates.'}
          </p>
        </section>
      )}

      <section className="usage-section weekly-usage-plans" aria-label="Eris Cloud plans">
        <h3>Eris Cloud plans</h3>
        <div className="weekly-usage-plan-grid">
          {(['free', 'pro'] as const).map((plan) => (
            <div
              key={plan}
              className="weekly-usage-plan"
              data-current={entitlement?.authenticated && entitlement.plan === plan}
            >
              <div className="weekly-usage-plan-title">
                <strong>Cloud {plan === 'free' ? 'Free' : 'Pro'}</strong>
                {entitlement?.authenticated && entitlement.plan === plan && (
                  <span className="usage-muted">Your plan</span>
                )}
              </div>
              <div>
                {plan === 'free' && entitlement?.authenticated && entitlement.plan === 'free' && hostedAllowance
                  ? `${numberFormat.format(hostedAllowance.remaining)} of ${numberFormat.format(hostedAllowance.limit)} cloud tokens remaining`
                  : ERIS_CLOUD_WEEKLY_TOKEN_LIMIT[plan] === null
                  ? 'Unlimited cloud tokens'
                  : `${compactFormat.format(ERIS_CLOUD_WEEKLY_TOKEN_LIMIT.free)} cloud tokens per week`}
              </div>
            </div>
          ))}
        </div>
        <p className="usage-muted weekly-usage-footnote">
          Local and other provider tokens are outside the Eris Cloud allowance. The usage above
          shows activity on this device.
        </p>
        <div className="weekly-usage-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void window.ide.ericServicesOpenAccount()}
          >
            {entitlement?.authenticated ? 'Manage account' : 'Sign in'}
          </button>
          {entitlement?.plan !== 'pro' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void window.ide.ericServicesOpenUpgrade()}
            >
              Upgrade to Pro
            </button>
          )}
        </div>
      </section>

      <details className="weekly-usage-history">
        <summary>Manage device history</summary>
        <div className="weekly-usage-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void clearHistory(true)}
          >
            Clear today
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void clearHistory(false)}
          >
            Clear all
          </button>
        </div>
      </details>
    </div>
  )
}
