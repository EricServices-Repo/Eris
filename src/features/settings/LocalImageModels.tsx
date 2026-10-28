import { useCallback, useEffect, useState } from 'react'
import type { LocalImageProgress, LocalImageStatus } from '@/shared/image-generation'

const presets = [
  {
    repoId: 'stabilityai/sd-turbo',
    label: 'SD-Turbo',
    description: 'Fast local generation with a smaller download. A good default for most devices.',
    tags: ['Stable Diffusion', '512 px', 'Fast']
  },
  {
    repoId: 'stabilityai/sdxl-turbo',
    label: 'SDXL-Turbo',
    description:
      'Higher image quality with a larger memory footprint. Eris falls back to SD-Turbo when unified memory is too low.',
    tags: ['SDXL', '512 px', '24 GB+ recommended']
  }
]

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 2)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

function progressLabel(progress: LocalImageProgress | null): string {
  if (!progress) return ''
  if (progress.total && progress.completed != null) {
    const unit = progress.unit ? ` ${progress.unit}` : ''
    return `${progress.message} · ${Math.floor(progress.completed)}/${progress.total}${unit}`
  }
  return progress.message
}

export function LocalImageModels({ onDownloaded }: { onDownloaded: () => Promise<void> }) {
  const [reuseVersions, setReuseVersions] = useState(true)
  const [backend, setBackend] = useState<'auto' | 'cpu' | 'cuda'>('auto')
  const [status, setStatus] = useState<LocalImageStatus | null>(null)
  const [repo, setRepo] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<LocalImageProgress | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await window.ide.localImageStatus())
    } catch (loadError) {
      setError(String(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
    const unsubscribe = window.ide.onLocalImageProgress((event) => {
      setProgress(event)
      setNotice('')
      setError('')
    })
    return unsubscribe
  }, [load])

  const run = async (
    action: () => ReturnType<typeof window.ide.setupLocalImageRuntime>,
    options: { downloaded?: boolean; success?: string } = {}
  ) => {
    setBusy(true)
    setError('')
    setNotice('Preparing local image generation…')
    setProgress(null)
    try {
      if (token.trim()) {
        await window.ide.setSecret('huggingface.imageToken', token.trim())
        setToken('')
      }
      const result = await action()
      if (!result.ok) throw new Error(result.error ?? 'Local image operation failed')
      if (result.status) setStatus(result.status)
      else await load()
      if (options.downloaded) await onDownloaded()
      setNotice(options.success ?? 'Local image runtime is ready.')
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError))
      await load()
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  const cancel = async () => {
    const cancelled = await window.ide.cancelLocalImageOperation()
    if (cancelled) setNotice('Stopping local image operation…')
  }

  const active = status?.models.find((model) => model.id === status.activeModelId)
  const pct =
    progress?.total && progress.completed != null
      ? Math.min(100, Math.max(2, Math.round((progress.completed / progress.total) * 100)))
      : 8

  return (
    <div className="local-image-models">
      <section className="models-card image-runtime-card">
        <label>
          Setup backend{' '}
          <select
            value={backend}
            disabled={busy}
            onChange={(e) => setBackend(e.target.value as 'auto' | 'cpu' | 'cuda')}
          >
            <option value="auto">Automatic</option>
            <option value="cpu">CPU fallback</option>
            <option value="cuda">NVIDIA CUDA</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={reuseVersions}
            disabled={busy}
            onChange={(e) => setReuseVersions(e.target.checked)}
          />{' '}
          Reuse installed versions when repairing (turn off to resolve a fresh dependency set)
        </label>
        {status?.runtime.setup && (
          <p role="status">
            {status.runtime.setup.phase}: {status.runtime.setup.message}
          </p>
        )}
        {status?.runtime.provenance && (
          <details>
            <summary>Installed environment versions</summary>
            <pre>{JSON.stringify(status.runtime.provenance, null, 2)}</pre>
          </details>
        )}
        <header className="models-card-head">
          <div>
            <h3>Local image runtime</h3>
            <p>Runs Diffusers privately on this computer and selects the best available device.</p>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(() => window.ide.setupLocalImageRuntime({ backend, reuseVersions }))
            }
          >
            {status?.runtime.ready ? 'Repair' : 'Set up runtime'}
          </button>
          {busy && progress?.operation === 'setup' && (
            <button type="button" className="btn" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
        </header>

        <div
          className={`image-runtime-status${status?.runtime.ready ? ' is-ready' : status ? ' is-warn' : ''}`}
        >
          <span className="image-runtime-dot" aria-hidden="true" />
          <span>
            <strong>
              {status?.runtime.ready
                ? 'Runtime ready'
                : status
                  ? 'Runtime needs setup'
                  : 'Checking runtime…'}
            </strong>
            <small>
              {status?.runtime.ready
                ? (status.runtime.deviceName ?? status.runtime.device ?? 'Device detected')
                : (status?.runtime.error ?? 'Checking Python and acceleration support')}
            </small>
          </span>
        </div>
        <p className="models-hint">
          Setup creates a private Python environment with PyTorch and Diffusers. CUDA, Apple Metal,
          and CPU are detected automatically. Eris caps Metal memory and stops unsafe generations
          before they can make the system unresponsive.
        </p>
      </section>

      <section className="models-card image-model-library">
        <div className="ollama-library">
          <div className="local-models-section-label">
            <strong>On this device</strong>
            <span className="model-conn-meta">
              {status?.models.length
                ? `${status.models.filter((model) => model.ready).length} ready`
                : 'No models downloaded'}
            </span>
          </div>

          {status?.models.length ? (
            <div className="ollama-catalog image-model-installed-list">
              {status.models.map((model) => {
                const isActive = model.id === status.activeModelId
                return (
                  <div
                    className={`ollama-catalog-row${model.ready ? ' is-ready' : ''}`}
                    key={model.id}
                  >
                    <div className="ollama-catalog-main">
                      <div className="ollama-catalog-title">
                        <strong>
                          {model.repoId.split('/')[model.repoId.split('/').length - 1] ??
                            model.repoId}
                        </strong>
                        <code>{model.repoId}</code>
                        <span className="badge">{formatBytes(model.bytes)}</span>
                        {isActive && <span className="models-tag is-accent">Default</span>}
                      </div>
                      <p>{model.ready ? 'Ready on this device' : 'Download is incomplete'}</p>
                    </div>
                    <div className="ollama-catalog-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${model.repoId}? You can download it again later.`
                            )
                          ) {
                            void run(() => window.ide.deleteLocalImageModel(model.id), {
                              success: 'Image model deleted.'
                            })
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="models-empty image-model-empty">
              Download a model below to generate images locally. The newest compatible download
              becomes the default.
            </div>
          )}

          <div className="image-model-divider" />

          <div className="ollama-library-head">
            <div>
              <strong>Find more</strong>
              <span className="model-conn-meta">
                Curated Diffusers models and custom Hugging Face repositories
              </span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void window.ide.openExternal(
                  'https://huggingface.co/models?pipeline_tag=text-to-image&library=diffusers'
                )
              }
            >
              Browse Hugging Face
            </button>
          </div>

          <div className="ollama-catalog image-model-catalog">
            {presets.map((preset) => {
              const installed = status?.models.some(
                (model) => model.repoId === preset.repoId && model.ready
              )
              const isDownloading = busy && progress?.repoId === preset.repoId
              return (
                <div
                  className={`ollama-catalog-row${installed ? ' is-ready' : ''}`}
                  key={preset.repoId}
                >
                  <div className="ollama-catalog-main">
                    <div className="ollama-catalog-title">
                      <strong>{preset.label}</strong>
                      <code>{preset.repoId}</code>
                      {preset.tags.map((tag) => (
                        <span className="badge" key={tag}>
                          {tag}
                        </span>
                      ))}
                      {installed && <span className="models-tag is-accent">Ready</span>}
                    </div>
                    <p>{preset.description}</p>
                    {isDownloading && (
                      <>
                        <div className="models-progress">
                          <div style={{ width: `${pct}%` }} />
                        </div>
                        <div className="model-conn-meta image-model-progress-label">
                          {progressLabel(progress)}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="ollama-catalog-actions">
                    {isDownloading ? (
                      <button type="button" className="btn" onClick={() => void cancel()}>
                        Cancel
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || installed}
                          onClick={() =>
                            void run(() => window.ide.downloadLocalImageModel(preset.repoId), {
                              downloaded: true,
                              success: 'Model downloaded and selected for local image generation.'
                            })
                          }
                        >
                          {installed ? 'Downloaded' : 'Download'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            void window.ide.openExternal(`https://huggingface.co/${preset.repoId}`)
                          }
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

          <div className="image-custom-model">
            <div className="local-models-section-label">
              <strong>Add from Hugging Face</strong>
              <span className="model-conn-meta">Paste a Diffusers repository or URL</span>
            </div>
            <div className="image-custom-model-row">
              <input
                value={repo}
                disabled={busy}
                spellCheck={false}
                placeholder="owner/model or https://huggingface.co/owner/model"
                aria-label="Hugging Face image repository"
                onChange={(event) => setRepo(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !repo.trim()}
                onClick={() =>
                  void run(() => window.ide.downloadLocalImageModel(repo.trim()), {
                    downloaded: true,
                    success: 'Model downloaded and selected for local image generation.'
                  })
                }
              >
                Download
              </button>
              {busy &&
                progress?.repoId &&
                !presets.some((preset) => preset.repoId === progress.repoId) && (
                  <button type="button" className="btn" onClick={() => void cancel()}>
                    Cancel
                  </button>
                )}
            </div>
            {busy &&
              progress?.repoId &&
              !presets.some((preset) => preset.repoId === progress.repoId) && (
                <>
                  <div className="models-progress">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                  <div className="model-conn-meta image-model-progress-label">
                    {progressLabel(progress)}
                  </div>
                </>
              )}
            <details className="image-model-advanced">
              <summary>Gated model access</summary>
              <label className="image-settings-field">
                <span>Hugging Face token</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  disabled={busy}
                  placeholder="Optional token for gated models"
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              <p className="models-hint">
                Accept the repository terms on Hugging Face first. The token is stored securely.
              </p>
            </details>
            <p className="models-hint">
              Supports Stable Diffusion and SDXL Diffusers repositories with safetensors weights.
              Downloads can be several GB.
            </p>
          </div>

          {(notice || progress) && !error && (
            <p className="image-settings-notice" role="status">
              {progress ? progressLabel(progress) : notice}
            </p>
          )}
          {error && (
            <p className="models-download-error" role="alert">
              {error}
            </p>
          )}
          {active && (
            <p className="models-hint image-active-model">
              <span className="models-tag is-accent">Default</span>
              Eris will use <code>{active.repoId}</code> for the next local image request.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
