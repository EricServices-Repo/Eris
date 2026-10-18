import { useRef, useState } from 'react'
import { imageAssetUrl, type GeneratedImageAsset } from '@/shared/image-generation'

export function ImageMessage({ asset }: { asset: GeneratedImageAsset }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [failed, setFailed] = useState(false)
  const [destination, setDestination] = useState(`assets/generated/${asset.id}.png`)
  const [savedPath, setSavedPath] = useState(asset.path ?? '')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <figure className="generated-image-card">
      {failed ? (
        <p role="alert">Image is unavailable. Its saved file may have been removed.</p>
      ) : (
        <button
          type="button"
          className="generated-image-preview"
          onClick={() => dialog.current?.showModal()}
          aria-label="Enlarge generated image"
        >
          <img
            src={imageAssetUrl(asset.id)}
            alt={asset.prompt}
            loading="lazy"
            width={asset.width}
            height={asset.height}
            onError={() => setFailed(true)}
          />
        </button>
      )}
      <figcaption>
        {asset.width} × {asset.height} · {asset.model} · {asset.provider}
        {asset.path ? ` · ${asset.path}` : ''}
      </figcaption>
      <details>
        <summary>Generation prompt</summary>
        <p>{asset.prompt}</p>
        {asset.revisedPrompt && <p>{asset.revisedPrompt}</p>}
      </details>
      <label className="field">
        <span>Save a copy to workspace</span>
        <input
          aria-label="Image destination path"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
        />
      </label>
      <button
        className="btn"
        disabled={saving || failed || !destination.trim()}
        onClick={async () => {
          setSaving(true)
          try {
            const result = await window.ide.saveImageToWorkspace(asset.id, destination.trim())
            if (result.ok) setSavedPath(destination.trim())
            setNotice(result.ok ? `Saved ${destination}` : (result.error ?? 'Could not save image'))
          } catch (error) {
            setNotice(String(error))
          } finally {
            setSaving(false)
          }
        }}
      >
        {saving ? 'Saving…' : 'Save image'}
      </button>
      <button
        className="btn"
        disabled={!savedPath}
        onClick={() =>
          void navigator.clipboard
            .writeText(savedPath)
            .catch(() => setNotice('Could not copy path'))
        }
      >
        Copy path
      </button>
      {notice && <p role="status">{notice}</p>}
      <dialog ref={dialog} className="generated-image-dialog" aria-label="Generated image preview">
        <button className="btn" autoFocus onClick={() => dialog.current?.close()}>
          Close
        </button>
        <img src={imageAssetUrl(asset.id)} alt={asset.prompt} />
      </dialog>
    </figure>
  )
}
