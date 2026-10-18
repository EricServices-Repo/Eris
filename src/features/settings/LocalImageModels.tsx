import { useEffect, useState } from 'react'
import type { LocalImageStatus } from '@/shared/image-generation'

const presets = [
  {
    repoId: 'stabilityai/sd-turbo',
    label: 'SD-Turbo',
    description: 'Lightweight default. Fast 512 px artwork; suitable for smaller GPUs.'
  },
  {
    repoId: 'stabilityai/sdxl-turbo',
    label: 'SDXL-Turbo',
    description: 'Larger download and memory requirements; stronger image quality.'
  }
]

export function LocalImageModels({ onDownloaded }: { onDownloaded: () => Promise<void> }) {
  const [status, setStatus] = useState<LocalImageStatus | null>(null)
  const [repo, setRepo] = useState('stabilityai/sd-turbo')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let mounted = true
    void window.ide
      .localImageStatus()
      .then((next) => {
        if (mounted) setStatus(next)
      })
      .catch((error) => {
        if (mounted) setNotice(String(error))
      })
    const unsubscribe = window.ide.onLocalImageProgress((event) => {
      const progress =
        event.total && event.completed != null
          ? ` (${Math.floor(event.completed)}/${event.total} ${event.unit ?? ''})`
          : ''
      setNotice(event.message + progress)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])
  const run = async (
    action: () => ReturnType<typeof window.ide.setupLocalImageRuntime>,
    downloaded = false
  ) => {
    setBusy(true)
    setNotice('Preparing local image generation…')
    try {
      if (token.trim()) {
        await window.ide.setSecret('huggingface.imageToken', token.trim())
        setToken('')
      }
      const result = await action()
      if (!result.ok) throw new Error(result.error ?? 'Local image operation failed')
      if (result.status) setStatus(result.status)
      if (downloaded) await onDownloaded()
      setNotice(
        downloaded
          ? 'Model downloaded. Image generation will use it automatically.'
          : 'Local image runtime is ready.'
      )
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }
  const active = status?.models.find((model) => model.id === status.activeModelId)
  return (
    <div className="local-image-models">
      <p>
        Image models run only when the image tool is called. They do not appear in the chat model
        picker. The most recently downloaded compatible model is used automatically.
      </p>
      <p role="status">
        {status?.runtime.ready
          ? `Runtime ready · ${status.runtime.deviceName ?? status.runtime.device}`
          : (status?.runtime.error ?? 'Checking local runtime…')}
      </p>
      <button
        className="btn"
        disabled={busy}
        onClick={() => void run(() => window.ide.setupLocalImageRuntime())}
      >
        Set up / repair image runtime
      </button>
      <p className="models-hint">
        Requires Python 3.10–3.12. Setup installs PyTorch and Diffusers into a private environment.
        CUDA, Apple Metal, and CPU are detected automatically. CPU generation is slower.
      </p>
      <p>
        {active
          ? `Automatic image model: ${active.repoId}`
          : 'No local image model downloaded yet.'}
      </p>
      {presets.map((preset) => (
        <div className="ollama-catalog-row" key={preset.repoId}>
          <div className="ollama-catalog-main">
            <strong>{preset.label}</strong>
            <p>{preset.description}</p>
            <a href={`https://huggingface.co/${preset.repoId}`} target="_blank" rel="noreferrer">
              Model details and license
            </a>
          </div>
          <button
            className="btn"
            disabled={
              busy || status?.models.some((model) => model.repoId === preset.repoId && model.ready)
            }
            onClick={() => void run(() => window.ide.downloadLocalImageModel(preset.repoId), true)}
          >
            {status?.models.some((model) => model.repoId === preset.repoId && model.ready)
              ? 'Downloaded'
              : 'Download from Hugging Face'}
          </button>
        </div>
      ))}
      <label className="field">
        <span>Hugging Face image repository</span>
        <input
          value={repo}
          disabled={busy}
          placeholder="owner/model or Hugging Face URL"
          onChange={(event) => setRepo(event.target.value)}
        />
      </label>
      <p className="models-hint">
        Supports Stable Diffusion and SDXL Diffusers repositories with safetensors weights. GGUF
        chat models, custom Python pipelines, and standalone checkpoints are unsupported.
      </p>
      <label className="field">
        <span>Hugging Face token (optional for gated models)</span>
        <input
          type="password"
          autoComplete="off"
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <p className="models-hint">
        For gated models, first accept the model's access terms on Hugging Face. Downloads include
        tokenizer/config files and weights and can take several GB.
      </p>
      <button
        className="btn"
        disabled={busy || !repo.trim()}
        onClick={() => void run(() => window.ide.downloadLocalImageModel(repo), true)}
      >
        Download image model
      </button>
      <button
        className="btn"
        onClick={() =>
          void window.ide.cancelLocalImageOperation().then((cancelled) => {
            if (cancelled) setNotice('Stopping local image operation…')
          })
        }
      >
        Cancel setup / download
      </button>
      {status?.models.map((model) => (
        <div className="ollama-catalog-row" key={model.id}>
          <span>
            {model.repoId} · {(model.bytes / 1e9).toFixed(2)} GB
            {model.id === status.activeModelId ? ' · automatic' : ''}
            {model.ready ? '' : ' · incomplete'}
          </span>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => window.ide.deleteLocalImageModel(model.id))}
          >
            Remove download
          </button>
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
