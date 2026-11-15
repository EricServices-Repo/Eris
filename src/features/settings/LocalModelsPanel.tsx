import { useEffect, useMemo, useState } from 'react'
import type { HfGgufSearchHit, LocalModelStatus } from '@/shared/settings-schema'
import type { ApplySetting } from './fields'
import './local-models.css'

const MODEL_VIEWS = [
  { id: 'installed', label: 'On this device' },
  { id: 'recommended', label: 'Recommended' },
  { id: 'hub', label: 'Hugging Face' }
] as const

const HUB_PAGE_SIZE = 6
const HF_BROWSE_FALLBACK = 'https://huggingface.co/models?library=gguf&sort=downloads'

function sizeLabel(b: LocalModelStatus): string {
  return (
    b.sizeLabel ||
    (b.approxBytes >= 1e9
      ? `~${(b.approxBytes / 1e9).toFixed(1)} GB`
      : `~${Math.round(b.approxBytes / 1e6)} MB`)
  )
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Match all query tokens against name / family / quant / filename / etc. */
function matchesLocalQuery(m: LocalModelStatus, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    m.name,
    m.displayName,
    m.description,
    m.ref,
    m.family,
    m.parameters,
    m.quant,
    m.filename,
    m.id
  ]
    .join(' ')
    .toLowerCase()
  const tokens = q.split(/[\s,/]+/).filter(Boolean)
  return tokens.every((t) => hay.includes(t))
}

export function LocalModelsPanel({
  models,
  defaultModel,
  apply,
  load
}: {
  models: LocalModelStatus[]
  defaultModel: string
  apply: ApplySetting
  load: () => Promise<void>
}) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [view, setView] = useState<(typeof MODEL_VIEWS)[number]['id']>('recommended')
  const [query, setQuery] = useState('')
  const [hubQuery, setHubQuery] = useState('')
  const [hubPage, setHubPage] = useState(0)
  const activeHubQuery = view === 'hub' ? hubQuery.trim() : ''
  const [family, setFamily] = useState('all')
  const [browseUrl, setBrowseUrl] = useState(HF_BROWSE_FALLBACK)
  const [hfHits, setHfHits] = useState<HfGgufSearchHit[]>([])
  const [hfSearching, setHfSearching] = useState(false)
  const [hfError, setHfError] = useState<string | null>(null)
  const [hfDownloadingRepo, setHfDownloadingRepo] = useState<string | null>(null)

  useEffect(() => {
    void window.ide
      .hfGgufBrowseUrl()
      .then(setBrowseUrl)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const active = models.find((m) => m.downloading)
    if (active) setDownloadingId(active.id)
  }, [models])

  useEffect(() => {
    return window.ide.onLocalDownloadProgress((s) => {
      // Parent SettingsModal patches status from this event — do not reload
      // full modelsStatus() here (slow probes cause % to jump backwards).
      if (s.downloading) setDownloadingId(s.id)
      else if (s.ready || s.downloadError) setDownloadingId((cur) => (cur === s.id ? null : cur))
    })
  }, [])

  useEffect(() => {
    const q = activeHubQuery
    if (q.length < 2) {
      setHfHits([])
      setHfError(null)
      setHfSearching(false)
      return
    }
    let cancelled = false
    setHfHits([])
    setHfSearching(true)
    setHfError(null)
    const timer = window.setTimeout(() => {
      void window.ide
        .searchHfGgufModels(q)
        .then((hits) => {
          if (!cancelled) setHfHits(hits)
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setHfHits([])
            setHfError(err instanceof Error ? err.message : 'Hugging Face search failed')
          }
        })
        .finally(() => {
          if (!cancelled) setHfSearching(false)
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeHubQuery])

  const families = useMemo(() => {
    const set = new Set(models.map((m) => m.family).filter(Boolean))
    return ['all', ...Array.from(set)]
  }, [models])

  const installed = useMemo(() => {
    // Ready + in-progress / paused — always above search (not filtered).
    const ready = models.filter((m) => m.ready)
    const active = models.filter(
      (m) =>
        !m.ready && (m.downloading || m.id === downloadingId || (m.progress > 0 && m.progress < 1))
    )
    const readyIds = new Set(ready.map((m) => m.id))
    return [...ready, ...active.filter((m) => !readyIds.has(m.id))]
  }, [models, downloadingId])

  const installedIds = useMemo(() => new Set(installed.map((m) => m.id)), [installed])

  const catalog = useMemo(() => {
    return models.filter((m) => {
      if (installedIds.has(m.id)) return false
      if (family !== 'all' && m.family !== family) return false
      return matchesLocalQuery(m, query)
    })
  }, [models, query, family, installedIds])

  const modelsByRepo = useMemo(() => {
    const byRepo = new Map<string, LocalModelStatus[]>()
    for (const model of models) {
      const match = model.downloadUrl.match(
        /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\//i
      )
      if (!match?.[1]) continue
      const repo = match[1].toLowerCase()
      const entries = byRepo.get(repo) ?? []
      entries.push(model)
      byRepo.set(repo, entries)
    }
    return byRepo
  }, [models])

  const startDownload = (m: LocalModelStatus) => {
    setDownloadingId(m.id)
    setFamily('all')
    void window.ide
      .downloadLocalModel(m.id)
      .then(async () => {
        await load()
        if (!defaultModel || defaultModel.startsWith('builtin:composer')) {
          await apply(['models', 'defaultModel'], m.ref)
        }
      })
      .catch(async (err: unknown) => {
        await load()
        window.alert(err instanceof Error ? err.message : 'Download failed')
      })
      .finally(() => setDownloadingId(null))
  }

  const startHfDownload = (hit: HfGgufSearchHit) => {
    setHfDownloadingRepo(hit.repoId)
    setFamily('all')
    // Progress events carry the real catalog id (hf-…) once Hub resolve finishes.
    void window.ide
      .downloadLocalModelFromHf(hit.repoId)
      .then(async (status) => {
        setDownloadingId(status.id)
        await load()
        if (!defaultModel || defaultModel.startsWith('builtin:composer')) {
          await apply(['models', 'defaultModel'], status.ref)
        }
      })
      .catch(async (err: unknown) => {
        await load()
        window.alert(err instanceof Error ? err.message : 'Download failed')
      })
      .finally(() => {
        setHfDownloadingRepo(null)
        setDownloadingId(null)
      })
  }

  const renderRow = (m: LocalModelStatus) => {
    const isDownloading = downloadingId === m.id || Boolean(m.downloading)
    const pct = Math.round((m.progress || 0) * 100)
    const isDefault = defaultModel === m.ref
    const statusLine = m.ready
      ? 'Ready on this device'
      : isDownloading
        ? m.downloadPhase === 'verifying'
          ? 'Verifying…'
          : m.downloadPhase === 'finalizing'
            ? 'Installing…'
            : pct > 0
              ? `Downloading · ${pct}%`
              : 'Downloading…'
        : pct > 0
          ? `Paused · ${pct}% — Resume continues from here`
          : null
    return (
      <div key={m.id} className={`ollama-catalog-row${m.ready ? ' is-ready' : ''}`}>
        <div className="ollama-catalog-main">
          <div className="ollama-catalog-title">
            <strong>{m.displayName}</strong>
            {isDefault && <span className="models-tag is-accent">Default</span>}
          </div>
          <p className="text-models-meta">
            {[sizeLabel(m), m.family, m.quant].filter(Boolean).join(' · ')}
          </p>
          {m.description && m.description !== m.displayName && <p>{m.description}</p>}
          {(isDownloading || (!m.ready && m.progress > 0 && m.progress < 1)) && (
            <div className="models-progress">
              <div style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          )}
          {statusLine && <div className="model-conn-meta">{statusLine}</div>}
          {m.downloadError && !isDownloading && !m.ready && (
            <p className="models-download-error" title={m.downloadError}>
              {m.downloadError}
            </p>
          )}
        </div>
        <div className="ollama-catalog-actions">
          {m.ready ? (
            <>
              {!isDefault && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void apply(['models', 'defaultModel'], m.ref)}
                >
                  Use
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (window.confirm(`Delete ${m.displayName}? You can download it again later.`)) {
                    void window.ide.deleteLocalModel(m.id).then(() => load())
                  }
                }}
              >
                Delete
              </button>
            </>
          ) : isDownloading ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void window.ide.cancelLocalDownload()
                setDownloadingId(null)
                void load()
              }}
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Boolean(downloadingId || hfDownloadingRepo)}
                onClick={() => startDownload(m)}
              >
                {pct > 0 ? 'Resume' : m.downloadError ? 'Retry' : 'Download'}
              </button>
              {m.downloadUrl ? (
                <button
                  type="button"
                  className="btn"
                  title="Open download URL in browser"
                  onClick={() => void window.ide.openExternal(m.downloadUrl)}
                >
                  Open URL
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    )
  }

  const hubPageCount = Math.ceil(hfHits.length / HUB_PAGE_SIZE)
  const hubPageStart = hubPage * HUB_PAGE_SIZE

  return (
    <div className="text-models">
      <div className="text-models-views" role="group" aria-label="Model library">
        {MODEL_VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="btn"
            aria-pressed={view === id}
            onClick={() => {
              setView(id)
              setHubPage(0)
            }}
          >
            {label}
            {id === 'installed' && installed.length > 0 && (
              <span className="models-tag">{installed.length}</span>
            )}
          </button>
        ))}
        <button type="button" className="btn text-models-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {view === 'installed' &&
        (installed.length > 0 ? (
          <div className="ollama-catalog">{installed.map(renderRow)}</div>
        ) : (
          <p className="models-empty">Downloaded models and transfers appear here.</p>
        ))}

      {view === 'recommended' && (
        <>
          <div className="text-models-search">
            <input
              type="search"
              className="ollama-catalog-search"
              aria-label="Filter recommended models"
              placeholder="Filter recommended models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {families.length > 1 && (
              <select
                aria-label="Model family"
                value={family}
                onChange={(e) => setFamily(e.target.value)}
              >
                {families.map((f) => (
                  <option key={f} value={f}>
                    {f === 'all' ? 'All families' : f}
                  </option>
                ))}
              </select>
            )}
          </div>
          {catalog.length > 0 ? (
            <div className="ollama-catalog">{catalog.map(renderRow)}</div>
          ) : (
            <p className="models-empty">
              {query.trim() || family !== 'all'
                ? 'No recommended models match your filters.'
                : 'No additional recommended models.'}
            </p>
          )}
        </>
      )}

      {view === 'hub' && (
        <>
          <div className="text-models-search">
            <input
              type="search"
              className="ollama-catalog-search"
              aria-label="Search Hugging Face GGUF models"
              placeholder="Search GGUF models or paste a model URL"
              spellCheck={false}
              value={hubQuery}
              onChange={(e) => {
                setHubQuery(e.target.value)
                setHubPage(0)
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                const url = new URL(browseUrl)
                if (activeHubQuery) url.searchParams.set('search', activeHubQuery)
                void window.ide.openExternal(url.toString())
              }}
            >
              Browse Hub
            </button>
          </div>
          {activeHubQuery.length === 1 && (
            <p className="model-conn-meta">Enter at least two characters.</p>
          )}
          {activeHubQuery.length >= 2 &&
            (hfSearching ? (
              <p role="status" className="model-conn-meta">
                Searching Hugging Face…
              </p>
            ) : hfError ? (
              <p role="alert" className="models-download-error">
                {hfError}
              </p>
            ) : hfHits.length === 0 ? (
              <p className="models-empty">No GGUF models found.</p>
            ) : (
              <>
                <div className="ollama-catalog">
                  {hfHits.slice(hubPageStart, hubPageStart + HUB_PAGE_SIZE).map((hit) => {
                    const known = modelsByRepo.get(hit.repoId.toLowerCase())
                    if (known) return known.map(renderRow)
                    const busy = hfDownloadingRepo === hit.repoId
                    return (
                      <div key={hit.repoId} className="ollama-catalog-row text-models-hub-row">
                        <div className="ollama-catalog-main">
                          <strong>{hit.name}</strong>
                          <p className="text-models-meta">
                            {hit.repoId}
                            {hit.downloads > 0 && ` · ${formatDownloads(hit.downloads)} downloads`}
                          </p>
                          {busy && <p role="status">Preparing download…</p>}
                        </div>
                        <div className="ollama-catalog-actions">
                          {busy ? (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                void window.ide.cancelLocalDownload()
                                setHfDownloadingRepo(null)
                                setDownloadingId(null)
                              }}
                            >
                              Cancel
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={Boolean(downloadingId || hfDownloadingRepo)}
                                onClick={() => startHfDownload(hit)}
                              >
                                Download
                              </button>
                              <button
                                type="button"
                                className="btn"
                                aria-label={`Open ${hit.repoId} on Hugging Face`}
                                onClick={() => void window.ide.openExternal(hit.url)}
                              >
                                Open
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {hubPageCount > 1 && (
                  <div className="text-models-pagination">
                    <span className="model-conn-meta" role="status">
                      {hubPageStart + 1}–{Math.min(hubPageStart + HUB_PAGE_SIZE, hfHits.length)} of{' '}
                      {hfHits.length}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={hubPage === 0}
                      onClick={() => setHubPage((page) => page - 1)}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={hubPage + 1 >= hubPageCount}
                      onClick={() => setHubPage((page) => page + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            ))}
        </>
      )}
    </div>
  )
}
