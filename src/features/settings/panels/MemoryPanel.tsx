import { useEffect, useRef, useState } from 'react'
import { ContextMemorySettingsSchema } from '@/shared/context-memory'
import type { MemoryUsageStatus } from '@/shared/memory-usage'
import type { AppSettings } from '@/shared/settings-schema'
import { settingFields } from '../fields'

const ranges: Record<string, [number, number]> = {
  maxMemoryMiB: [16, 512],
  maxThreadMiB: [4, 128],
  maxMessages: [500, 100000],
  warmThreads: [1, 16],
  idleMinutes: [1, 120],
  foregroundDeadlineMs: [25, 2000],
  promptTokens: [128, 8192]
}
export function memoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
type Draft = Record<string, string | boolean>
function draftFrom(usage: MemoryUsageStatus): Draft {
  return Object.fromEntries([
    ...Object.entries(usage.config).map(([key, value]) => [
      key,
      typeof value === 'number' ? String(value) : value
    ]),
    ['projectMemory', usage.projectMemory]
  ])
}
export function MemoryPanel({
  activeThreadId,
  onChanged
}: {
  activeThreadId?: string | null
  onChanged: (settings: AppSettings) => void | Promise<void>
}) {
  const [usage, setUsage] = useState<MemoryUsageStatus | null>(null)
  const [samples, setSamples] = useState<Array<{ at: number; bytes: number }>>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    setUsage(null)
    let disposed = false
    let busy = false
    const poll = async () => {
      if (disposed || busy || document.hidden) return
      busy = true
      setRefreshing(true)
      try {
        const next = await window.ide.getMemoryUsage({ activeThreadId })
        if (!disposed) {
          setUsage(next)
          setSamples((previous) =>
            [
              ...previous,
              {
                at: next.at,
                bytes: next.cache.ownedBytes + next.cache.reservedBytes + next.cache.pinnedBytes
              }
            ].slice(-60)
          )
          setDraft((previous) => previous ?? draftFrom(next))
          setError('')
        }
      } catch (failure) {
        if (!disposed) setError(String(failure))
      } finally {
        busy = false
        if (!disposed) setRefreshing(false)
      }
    }
    refresh.current = () => {
      void poll()
    }
    void poll()
    const timer = window.setInterval(() => {
      void poll()
    }, 5000)
    const visible = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [activeThreadId])

  const save = async () => {
    if (!draft) return
    const values = Object.fromEntries(
      Object.entries(draft)
        .filter(([key]) => key !== 'projectMemory')
        .map(([key, value]) => [
          key,
          key in ranges ? (String(value).trim() ? Number(value) : NaN) : value
        ])
    )
    const parsed = ContextMemorySettingsSchema.safeParse(values)
    if (!parsed.success) {
      setNotice(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      )
      return
    }
    const projectMemory = draft.projectMemory
    if (projectMemory !== 'auto' && projectMemory !== 'ask' && projectMemory !== 'off') return
    setSaving(true)
    setNotice('')
    try {
      const next = await window.ide.setSettings('user', {
        agent: { contextMemory: parsed.data, projectMemory }
      })
      await onChanged(next)
      setNotice('Memory defaults saved.')
      refresh.current()
    } catch (failure) {
      setNotice(`Could not save memory defaults: ${String(failure)}`)
    } finally {
      setSaving(false)
    }
  }
  const cache = usage?.cache
  const charged = cache ? cache.ownedBytes + cache.reservedBytes + cache.pinnedBytes : 0
  const policyDiffers =
    usage && JSON.stringify(usage.config) !== JSON.stringify(usage.effectivePolicy)
  return (
    <div className="memory-panel">
      <section className="memory-section" aria-label="Memory usage">
        <div className="memory-heading">
          <h3>Memory usage</h3>
          <button
            className="btn"
            type="button"
            disabled={refreshing}
            onClick={() => refresh.current()}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p>
          RAM counters cover conversation caches across this Eris process. Saved history is stored
          separately on disk.
        </p>
        {error && (
          <p role="alert">
            Usage unavailable. {error} {usage && 'Last successful figures remain below.'}
          </p>
        )}
        {!usage && !error && <p role="status">Loading memory usage…</p>}
        {usage && (
          <>
            <div className="memory-cards">
              <div>
                <span>Active chat · estimated RAM</span>
                <strong>{memoryBytes(usage.cache.activeBytes)}</strong>
                <small>{activeThreadId ? 'Selected conversation cache' : 'No chat selected'}</small>
              </div>
              <div>
                <span>Historical chats · estimated RAM</span>
                <strong>{memoryBytes(usage.cache.historicalBytes)}</strong>
                <small>
                  Other cached conversations · {usage.cache.warmConversations} warm chats total
                </small>
              </div>
              <div>
                <span>Saved history · disk</span>
                <strong>
                  {usage.archive?.initialized
                    ? memoryBytes(usage.archive.databaseBytes + usage.archive.journalBytes)
                    : 'Unavailable'}
                </strong>
                <small>
                  {usage.archiveError ??
                    (usage.archive?.initialized
                      ? `${usage.archive.conversations.toLocaleString()} chats · ${usage.archive.messages.toLocaleString()} messages`
                      : 'Archive not initialized; legacy files are not included.')}
                </small>
              </div>
            </div>
            <p>
              Estimated cache allocation: <b>{memoryBytes(charged)}</b> /{' '}
              {memoryBytes(usage.cache.envelopeBytes)} effective budget.
            </p>
            <progress
              aria-label="Estimated conversation cache budget used"
              value={charged}
              max={Math.max(1, usage.cache.envelopeBytes)}
            />
            <p className="memory-detail">
              Owned {memoryBytes(usage.cache.ownedBytes)} · Reserved{' '}
              {memoryBytes(usage.cache.reservedBytes)} · Retained snapshots{' '}
              {memoryBytes(usage.cache.pinnedBytes)}. The effective budget may shrink under system
              memory pressure.
            </p>
            {samples.length > 0 && (
              <div className="memory-trend" aria-label="Recent cache allocation history">
                <h4>Recent RAM history</h4>
                <p className="memory-detail">
                  Up to 60 samples from this Settings session. Estimated cache allocation, including
                  reservations and retained snapshots. Peak:{' '}
                  {memoryBytes(Math.max(...samples.map((sample) => sample.bytes)))}.
                </p>
                <div className="memory-trend-bars" aria-hidden="true">
                  {samples.map((sample, index) => (
                    <span
                      key={`${sample.at}-${index}`}
                      title={`${new Date(sample.at).toLocaleTimeString()}: ${memoryBytes(sample.bytes)}`}
                      style={{
                        height: `${Math.max(3, (100 * sample.bytes) / Math.max(1, ...samples.map((item) => item.bytes)))}%`
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            <p className="memory-detail">
              Renderer history (estimated): {memoryBytes(usage.rendererHistoryBytes)}. This separate
              owner reduces the available conversation cache budget.
            </p>
            <p className="memory-detail">
              Main process RAM (RSS): {memoryBytes(usage.process.rss)} · JavaScript heap used:{' '}
              {memoryBytes(usage.process.heapUsed)}. Excludes renderer, model workers, and GPU
              memory; includes more than conversation memory.
            </p>
            <p className="memory-detail">
              Disk figures include the SQLite database and journals for{' '}
              {usage.scope === 'workspace' ? 'this workspace' : 'your profile'}, including the
              active chat. They are separate from RAM and may include reusable database space.
            </p>
            <small>
              Updated {new Date(usage.at).toLocaleTimeString()} · Refreshes every 5 seconds while
              visible.
            </small>
          </>
        )}
      </section>
      <section className="memory-section" aria-label="Memory configuration">
        <h3>Memory defaults</h3>
        <p>
          Saved to your user settings for all workspaces. Evicting RAM keeps saved conversations on
          disk.
        </p>
        {policyDiffers && (
          <p>
            Workspace overrides are active: recall{' '}
            {usage.effectivePolicy.enabled ? 'enabled' : 'disabled'}, remote recall{' '}
            {usage.effectivePolicy.shareWithRemoteModels ? 'allowed' : 'blocked'}, token ceiling{' '}
            {usage.effectivePolicy.promptTokens}, deadline{' '}
            {usage.effectivePolicy.foregroundDeadlineMs} ms. RAM allocation remains controlled by
            user settings.
          </p>
        )}
        {draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={saving} className="memory-fields">
              <legend className="sr-only">Conversation memory defaults</legend>
              {settingFields([])
                .filter((field) => field.cat === 'memory')
                .map((field) => {
                  const key = field.path[field.path.length - 1]
                  const id = `memory-${key}`
                  const value = draft[key]
                  return (
                    <div className="memory-field" key={key}>
                      <div>
                        <label htmlFor={id}>{field.label}</label>
                        <p id={`${id}-hint`}>{field.hint}</p>
                      </div>
                      {field.type === 'boolean' ? (
                        <input
                          id={id}
                          aria-describedby={`${id}-hint`}
                          type="checkbox"
                          checked={value === true}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
                        />
                      ) : field.type === 'select' ? (
                        <select
                          id={id}
                          aria-describedby={`${id}-hint`}
                          value={String(value)}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        >
                          {field.options?.map((option) => (
                            <option key={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={id}
                          aria-describedby={`${id}-hint`}
                          type="number"
                          min={ranges[key]?.[0]}
                          max={ranges[key]?.[1]}
                          step="1"
                          required
                          value={String(value)}
                          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                        />
                      )}
                    </div>
                  )
                })}
            </fieldset>
            <div className="memory-actions">
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save memory defaults'}
              </button>
              <button
                className="btn"
                type="button"
                disabled={saving || !usage}
                onClick={() => {
                  if (usage) setDraft(draftFrom(usage))
                  setNotice('')
                }}
              >
                Reset changes
              </button>
            </div>
          </form>
        )}
        <p role="status">{notice}</p>
      </section>
    </div>
  )
}
