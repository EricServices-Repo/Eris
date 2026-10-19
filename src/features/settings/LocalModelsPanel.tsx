import { useEffect, useMemo, useState } from 'react'
import type { HfGgufSearchHit, LocalModelStatus } from '@/shared/settings-schema'
import type { ApplySetting } from './fields'

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
  const [query, setQuery] = useState('')
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
    const q = query.trim()
    if (q.length < 2) {
      setHfHits([])
      setHfError(null)
      setHfSearching(false)
      return
    }
    let cancelled = false
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
  }, [query])

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

  const catalogRepoIds = useMemo(() => {
    const set = new Set<string>()
    for (const m of models) {
      const match = m.downloadUrl.match(
        /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\//i
      )
      if (match) set.add(match[1].toLowerCase())
    }
    return set
  }, [models])

  const remoteHits = useMemo(
    () => hfHits.filter((h) => !catalogRepoIds.has(h.repoId.toLowerCase())),
    [hfHits, catalogRepoIds]
  )

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

  const showHfSection = query.trim().length >= 2

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
            <code>{m.ref}</code>
            <span className="badge">{sizeLabel(m)}</span>
            {m.family ? <span className="badge">{m.family}</span> : null}
            {isDefault && <span className="models-tag is-accent">Default</span>}
          </div>
          <p>{m.description}</p>
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
                disabled={Boolean(downloadingId)}
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

  return (
    <div className="ollama-library">
      <div className="ollama-library-head">
        <div>
          <strong>Text models</strong>
          <span className="model-conn-meta">
            Download a GGUF and it runs inside Eris — no Ollama app, no separate server.
          </span>
          <div className="local-models-source">
            <button
              type="button"
              className="btn-link"
              onClick={() => void window.ide.openExternal(browseUrl)}
            >
              Browse more on Hugging Face
            </button>
            <span className="model-conn-meta">
              Search by model name below, or paste a Hub repo / .gguf URL.
            </span>
          </div>
        </div>
      </div>

      {installed.length > 0 && (
        <section className="local-models-installed">
          <div className="local-models-section-label">
            <strong>On this device</strong>
            <span className="model-conn-meta">
              {(() => {
                const readyN = installed.filter((m) => m.ready).length
                const activeN = installed.length - readyN
                if (activeN > 0 && readyN > 0) {
                  return `${readyN} ready · ${activeN} downloading`
                }
                if (activeN > 0) return `${activeN} downloading`
                return `${readyN} ready`
              })()}
            </span>
          </div>
          <div className="ollama-catalog">{installed.map(renderRow)}</div>
        </section>
      )}

      <div className="ollama-catalog-filters">
        <div className="local-models-section-label">
          <strong>Find more</strong>
          <span className="model-conn-meta">Curated catalog and Hugging Face search</span>
        </div>
        <input
          className="ollama-catalog-search"
          value={query}
          placeholder="Search by name (qwen, phi-4, mistral…) or paste huggingface.co/…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ollama-family-tabs" role="tablist" aria-label="Model family">
          {families.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={family === f}
              className={`ollama-family-tab${family === f ? ' is-active' : ''}`}
              onClick={() => setFamily(f)}
            >
              {f === 'all' ? 'All' : f}
            </button>
          ))}
        </div>
      </div>

      <div className="ollama-catalog">
        {catalog.length === 0 ? (
          <div className="models-empty">
            {query.trim()
              ? 'No curated matches — try Hugging Face results below.'
              : installed.length > 0
                ? 'All curated models above are already on this device — search Hugging Face for more.'
                : 'No models in catalog.'}
          </div>
        ) : (
          catalog.map(renderRow)
        )}
      </div>

      {showHfSection && (
        <div className="local-models-hf">
          <div className="ollama-library-head">
            <div>
              <strong>Hugging Face</strong>
              <span className="model-conn-meta">
                {hfSearching
                  ? 'Searching Hub for GGUF models…'
                  : `Name search on huggingface.co (library=gguf) · prefers Q4_K_M`}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void window.ide.openExternal(
                  `${browseUrl}${browseUrl.includes('?') ? '&' : '?'}search=${encodeURIComponent(query.trim())}`
                )
              }
            >
              Open search
            </button>
          </div>
          {hfError && <p className="models-download-error">{hfError}</p>}
          {!hfSearching && !hfError && remoteHits.length === 0 && (
            <div className="models-empty">No extra Hub matches for “{query.trim()}”.</div>
          )}
          <div className="ollama-catalog">
            {remoteHits.map((hit) => {
              const busy = hfDownloadingRepo === hit.repoId
              return (
                <div key={hit.repoId} className="ollama-catalog-row">
                  <div className="ollama-catalog-main">
                    <div className="ollama-catalog-title">
                      <strong>{hit.name}</strong>
                      <code>{hit.repoId}</code>
                      {hit.downloads > 0 && (
                        <span className="badge">{formatDownloads(hit.downloads)} downloads</span>
                      )}
                    </div>
                    <p>
                      {busy
                        ? 'Adding to Text Models…'
                        : 'GGUF repo on Hugging Face — Eris picks a Q4_K_M (or closest) file.'}
                    </p>
                    {busy && (
                      <div className="models-progress">
                        <div style={{ width: '8%' }} />
                      </div>
                    )}
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
                          disabled={Boolean(downloadingId)}
                          onClick={() => startHfDownload(hit)}
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          className="btn"
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
        </div>
      )}
    </div>
  )
}
