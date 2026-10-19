import { useEffect, useState } from 'react'
import { LocalImageModels } from './LocalImageModels'
import type { AppSettings } from '@/shared/settings-schema'
import { ImageGenerationSettingsSchema } from '@/shared/image-generation-schema'
import type { ApplySetting } from './fields'

export function ImageGenerationSettings({
  resolved,
  apply
}: {
  resolved: AppSettings
  apply: ApplySetting
}) {
  const [draft, setDraft] = useState(resolved.images)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const providers = resolved.models.connections.filter(
    (connection) => connection.enabled && connection.type === 'openai-compatible'
  )
  const dirty = JSON.stringify(draft) !== JSON.stringify(resolved.images)

  useEffect(() => setDraft(resolved.images), [resolved.images])

  const save = async () => {
    if (
      draft.enabled &&
      draft.backend === 'api' &&
      (!draft.model.trim() || !providers.some((provider) => provider.id === draft.connectionId))
    ) {
      setNotice('Choose an enabled provider and enter its image model ID.')
      return
    }
    setBusy(true)
    setNotice('')
    try {
      await apply(['images'], draft)
      setNotice('Image generation settings saved.')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="models-card image-settings-card">
        <header className="models-card-head">
          <div>
            <h3>Image generation</h3>
            <p>
              Create images from chat with <code>/image your prompt</code>, or ask Composer to
              create an asset for your application.
            </p>
          </div>
          <span className={`models-tag${draft.enabled ? ' is-accent' : ''}`}>
            {draft.enabled ? 'Enabled' : 'Off'}
          </span>
        </header>

        <label className="image-generation-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          <span>
            <strong>Enable image tools</strong>
            <small>Let chat and Composer create PNG images when you ask.</small>
          </span>
        </label>

        <div className="image-settings-grid">
          <label className="image-settings-field">
            <span>Run images with</span>
            <select
              value={draft.backend}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  backend: event.target.value === 'local' ? 'local' : 'api',
                  size: event.target.value === 'local' ? '512x512' : '1024x1024'
                })
              }
            >
              <option value="local">Local Hugging Face model</option>
              <option value="api">Image API</option>
            </select>
          </label>

          <label className="image-settings-field">
            <span>Image size</span>
            <select
              value={draft.size}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  size: ImageGenerationSettingsSchema.shape.size.parse(event.target.value)
                })
              }
            >
              {(draft.backend === 'local'
                ? ['512x512', '768x512', '512x768', '1024x1024']
                : ['1024x1024', '1536x1024', '1024x1536']
              ).map((size) => (
                <option key={size}>{size}</option>
              ))}
            </select>
          </label>

          {draft.backend === 'api' && (
            <label className="image-settings-field">
              <span>Quality</span>
              <select
                value={draft.quality}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    quality: ImageGenerationSettingsSchema.shape.quality.parse(event.target.value)
                  })
                }
              >
                {['auto', 'low', 'medium', 'high'].map((quality) => (
                  <option key={quality}>{quality}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {draft.backend === 'api' && (
          <div className="image-api-settings">
            <label className="image-settings-field">
              <span>Image provider</span>
              <select
                value={draft.connectionId}
                onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}
              >
                <option value="">Choose a configured provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="image-settings-field">
              <span>Image model</span>
              <input
                value={draft.model}
                placeholder="Image model ID from your provider"
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
            </label>
          </div>
        )}

        <div className="image-settings-footer">
          <p className="models-hint">
            {draft.backend === 'local'
              ? 'Images stay on this computer. Eris automatically uses the most recently downloaded compatible model.'
              : 'API images use the selected provider and may incur provider charges.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
        {notice && (
          <p className="image-settings-notice" role="status">
            {notice}
          </p>
        )}
      </section>

      {draft.backend === 'local' && (
        <LocalImageModels
          onDownloaded={async () => {
            const next = { ...draft, enabled: true, backend: 'local' as const }
            await apply(['images'], next)
            setDraft(next)
          }}
        />
      )}
    </>
  )
}
