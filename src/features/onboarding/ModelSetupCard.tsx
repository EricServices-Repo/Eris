import { useEffect, useState } from 'react'
import type { ModelSetupOptions } from '@/shared/model-setup'

interface Props {
  onChanged: () => Promise<void>
  onOpenModels: () => void
  onOpenProviders: () => void
}

export function ModelSetupCard({ onChanged, onOpenModels, onOpenProviders }: Props) {
  const [options, setOptions] = useState<ModelSetupOptions | null>(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<number>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let mounted = true
    void window.ide.modelSetupOptions().then(
      (result) => { if (mounted) setOptions(result) },
      () => { if (mounted) setError('Could not check for local model servers.') }
    )
    return () => { mounted = false }
  }, [revision])
  const downloadId = options?.recommended?.id
  useEffect(() => {
    if (!downloadId || pending !== downloadId) return
    return window.ide.onLocalDownloadProgress((model) => {
      if (model.id === downloadId && model.approxBytes > 0)
        setProgress(Math.min(100, Math.floor(100 * model.downloadedBytes / model.approxBytes)))
    })
  }, [downloadId, pending])

  const act = async (id: string, run: () => Promise<unknown>) => {
    setPending(id)
    setError('')
    setProgress(undefined)
    try {
      await run()
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending('')
    }
  }

  return (
    <section className="model-setup-card" aria-label="Connect a model">
      <strong>Connect a model</strong>
      <p>Use a local model or connect a provider to start chatting.</p>
      <div className="model-setup-actions">
        {options?.services.map((service) => (
          <button
            key={service.id}
            className="btn btn-primary"
            type="button"
            disabled={Boolean(pending) || service.models.length === 0}
            onClick={() => void act(service.id, () => window.ide.connectDetectedModelService(service.id))}
          >
            {pending === service.id ? 'Connecting…' : service.models.length
              ? `Connect ${service.name}` : `${service.name} detected · no models`}
          </button>
        ))}
        {options?.recommended && (
          <button className="btn" type="button" disabled={Boolean(pending)}
            onClick={() => void act(downloadId!, () => window.ide.downloadLocalModel(downloadId!))}
          >
            {pending === downloadId
              ? `Downloading…${progress === undefined ? '' : ` ${progress}%`}`
              : `Download ${options.recommended.name} · ${options.recommended.sizeLabel}`}
          </button>
        )}
        <button className="btn" type="button" onClick={onOpenProviders}>Add a provider</button>
        <button className="btn" type="button" onClick={onOpenModels}>Browse models</button>
        {options && <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => setRevision((n) => n + 1)}>Check local servers</button>}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
