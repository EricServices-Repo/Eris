import { useState } from 'react'
import type { AppSettings, ModelsStatus } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { ModelConnectionsPanel } from '../ModelConnectionsPanel'
import { OllamaConfigPanel } from '../OllamaConfigPanel'

export function useModelsPanelState() {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  return { downloadingId, setDownloadingId, verifyingId, setVerifyingId }
}

export type ModelsPanelState = ReturnType<typeof useModelsPanelState>

export function ModelsPanel({
  state,
  resolved,
  status,
  apply,
  load
}: {
  state: ModelsPanelState
  resolved: AppSettings
  status: ModelsStatus | null
  apply: ApplySetting
  load: () => Promise<void>
}) {
  const { downloadingId, setDownloadingId, verifyingId, setVerifyingId } = state
  return (
    <div className="models-page" style={{ marginBottom: 16 }}>
      <div className="models-page-section">
        <div className="model-connections-intro">
          <strong>Built-in Composer</strong>
          <p>
            Runs locally in Eris.{' '}
            <strong>Lite</strong> is the chat face (~1 GB).{' '}
            <strong>Full</strong> (~4.7 GB) is the worker that finishes multi-file tool work.
            Keep Lite as the default; download and verify Full for reliable agent edits.
          </p>
        </div>
      {(status?.builtin ?? []).map((b) => {
        const sizeLabel =
          b.approxBytes >= 1e9
            ? `~${(b.approxBytes / 1e9).toFixed(1)} GB`
            : `~${Math.round(b.approxBytes / 1e6)} MB`
        const isDefault = resolved?.models.defaultModel === b.ref
        const isDownloading = downloadingId === b.id
        return (
          <div
            key={b.id}
            style={{
              marginBottom: 12,
              padding: 12,
              border: `1px solid ${isDefault ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              background: 'var(--bg)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span className={`status-dot ${b.ready ? 'ok' : ''}`} />
              <strong>{b.displayName}</strong>
              <span className="badge">built-in</span>
              {b.tier && <span className="badge">{b.tier}</span>}
              {isDefault && <span className="badge">default</span>}
              <span className="badge">
                {b.family} · {b.parameters} · {b.quant}
              </span>
            </div>
            <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
              {b.description}
            </p>
            <div style={{ color: 'var(--text-muted)', marginBottom: 8, fontSize: 12 }}>
              {b.ready
                ? `Ready · ${b.filename}`
                : b.installed
                  ? `Invalid / incomplete file · re-download ${sizeLabel}`
                  : `Not installed · ${sizeLabel} download into app data`}
              {isDownloading && b.progress > 0
                ? ` · ${Math.round(b.progress * 100)}%`
                : ''}
            </div>
            {!b.ready && b.progress > 0 && b.progress < 1 && (
              <div
                style={{
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--bg-hover)',
                  marginBottom: 8,
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    width: `${Math.round(b.progress * 100)}%`,
                    height: '100%',
                    background: 'var(--accent)'
                  }}
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {b.ready ? (
                <>
                  <button className="btn" onClick={() => void load()}>
                    Refresh
                  </button>
                  <button
                    className="btn"
                    disabled={verifyingId === b.id}
                    onClick={() => {
                      setVerifyingId(b.id)
                      void window.ide
                        .verifyBuiltinModel(b.id)
                        .then((result) => {
                          if (result.ok) {
                            window.alert(
                              `${b.displayName} checksum OK` +
                                (result.digest ? `\n${result.digest.slice(0, 16)}…` : '')
                            )
                          } else {
                            window.alert(result.error || 'Verification failed')
                          }
                          return load()
                        })
                        .catch((err: unknown) => {
                          window.alert(
                            err instanceof Error ? err.message : 'Verification failed'
                          )
                        })
                        .finally(() => setVerifyingId(null))
                    }}
                  >
                    {verifyingId === b.id ? 'Verifying…' : 'Verify checksum'}
                  </button>
                  {b.tier === 'lite' && !isDefault && (
                    <button
                      className="btn btn-primary"
                      onClick={() => void apply(['models', 'defaultModel'], b.ref)}
                    >
                      Use as chat default
                    </button>
                  )}
                  {b.tier === 'full' && (
                    <span className="badge" title="Full runs as the workspace worker when ready">
                      worker when ready
                    </span>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${b.displayName} from disk? You can download it again later.`
                        )
                      ) {
                        void window.ide.deleteBuiltinModel(b.id).then(() => load())
                      }
                    }}
                  >
                    Delete
                  </button>
                </>
              ) : isDownloading || (downloadingId && downloadingId !== b.id) ? (
                isDownloading ? (
                  <button
                    className="btn"
                    onClick={() => {
                      void window.ide.cancelBuiltinDownload()
                      setDownloadingId(null)
                    }}
                  >
                    Cancel download
                  </button>
                ) : (
                  <button className="btn" disabled>
                    Waiting…
                  </button>
                )
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setDownloadingId(b.id)
                    void window.ide
                      .downloadBuiltinModel(b.id)
                      .then(async () => {
                        await load()
                        const currentDefault = resolved?.models.defaultModel
                        // Lite stays the chat default; Full is the worker, not promoted.
                        const shouldPromote =
                          b.tier === 'lite' &&
                          (!currentDefault?.startsWith('builtin:') ||
                            currentDefault === b.ref ||
                            currentDefault === 'builtin:composer')
                        if (shouldPromote) {
                          await apply(['models', 'defaultModel'], b.ref)
                        }
                      })
                      .catch((err: unknown) => {
                        window.alert(
                          err instanceof Error ? err.message : 'Download failed'
                        )
                      })
                      .finally(() => setDownloadingId(null))
                  }}
                >
                  {b.installed ? 'Re-download' : 'Download'}{' '}
                  {b.tier === 'lite' ? 'Lite' : b.name} ({sizeLabel})
                </button>
              )}
            </div>
          </div>
        )
      })}
      </div>

      {resolved && (
        <OllamaConfigPanel
          resolved={resolved}
          status={status}
          defaultModel={resolved.models.defaultModel}
          onSaveConnections={async (connections) => {
            await apply(['models', 'connections'], connections)
          }}
          onRefresh={async () => {
            await load()
          }}
          onSetDefaultModel={async (model) => {
            await apply(['models', 'defaultModel'], model)
          }}
        />
      )}

      <ModelConnectionsPanel
        resolved={resolved}
        status={status}
        defaultModel={resolved.models.defaultModel}
        onSaveConnections={async (connections) => {
          await apply(['models', 'connections'], connections)
        }}
        onRefresh={async () => {
          await load()
        }}
        onSetDefaultModel={async (model) => {
          await apply(['models', 'defaultModel'], model)
        }}
      />
    </div>
  )
}
