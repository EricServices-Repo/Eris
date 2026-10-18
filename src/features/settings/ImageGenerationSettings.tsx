import { LocalImageModels } from './LocalImageModels'
import { useState } from 'react'
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
  return (
    <section className="models-card">
      <h3>Image generation</h3>
      <p>
        Generate locally with a Hugging Face model, or use an Images API. Generate with{' '}
        <code>/image your prompt</code> in chat, or ask Composer to create an asset for your
        application.
      </p>
      <label className="field">
        <span>Enable image generation</span>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
      </label>
      <label className="field">
        <span>Image generation backend</span>
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
      {draft.backend === 'local' && (
        <LocalImageModels
          onDownloaded={async () => {
            const next = { ...draft, enabled: true, backend: 'local' as const }
            await apply(['images'], next)
            setDraft(next)
          }}
        />
      )}
      {draft.backend === 'api' && (
        <>
          <label className="field">
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
          <label className="field">
            <span>Image model</span>
            <input
              value={draft.model}
              placeholder="Image model ID from your provider"
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          </label>
        </>
      )}
      <label className="field">
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
      <label className="field">
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
      <p className="models-hint">
        One PNG per request. Local generation stays on this computer and uses the installed image
        model automatically. Turbo models generate at their native 512 px size. Quality applies to
        GPT image APIs; cloud providers may charge.
      </p>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          if (
            draft.enabled &&
            draft.backend === 'api' &&
            (!draft.model.trim() ||
              !providers.some((provider) => provider.id === draft.connectionId))
          ) {
            setNotice('Choose an enabled provider and enter its image model ID.')
            return
          }
          setBusy(true)
          try {
            await apply(['images'], draft)
            setNotice('Image generation settings saved.')
          } catch (error) {
            setNotice(String(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Saving…' : 'Save image settings'}
      </button>
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
