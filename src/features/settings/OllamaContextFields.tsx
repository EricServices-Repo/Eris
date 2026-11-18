import type { ConnectionModelPlacement } from '@/shared/settings-schema'

export type { OllamaContextSettings } from './ollama-connections'
import type { OllamaContextSettings } from './ollama-connections'

/** Requested, loaded, placed and fitted, so a slow or shortened model has a visible cause (#677). */
export function placementText(item: ConnectionModelPlacement): string {
  const share = item.sizeBytes ? Math.round((item.vramBytes / item.sizeBytes) * 100) : 100
  const loaded = item.loadedWindow?.toLocaleString() ?? 'not reported'
  const window = `requested ${item.requestedWindow.toLocaleString()} tokens, loaded ${loaded}`
  const placed =
    share < 100
      ? `${item.model} is partly on CPU (${share}% in VRAM) and will run slower; ${window}.`
      : `${item.model} is fully in VRAM; ${window}.`
  if (item.minimumWindowSpills)
    return `${placed} The observed load still uses CPU memory at the minimum supported context. Review the server’s GPU allocation, other workloads, or model and cache quantization.`
  if (item.fittedWindow === undefined) return placed
  const why =
    item.fitReason === 'vram-plan'
      ? 'planned from the VRAM it has'
      : item.fitReason === 'out-of-memory'
        ? 'after the server ran out of memory'
        : 'to keep it in VRAM'
  return `${placed} Eris now uses ${item.fittedWindow.toLocaleString()} tokens, ${why}.`
}

/** Window sizing for one Ollama server. */
export function OllamaContextFields({
  value,
  onChange,
  onRemeasure,
  busy = false
}: {
  value: OllamaContextSettings
  onChange: (next: OllamaContextSettings) => void
  /** Forget fitted windows so the next load measures again. */
  onRemeasure?: () => void
  busy?: boolean
}) {
  const fit = value.contextFit ?? 'fit'
  return (
    <div className="ollama-context-fields">
      <label className="field">
        <span>Context window</span>
        <select
          value={fit}
          disabled={busy}
          onChange={(e) =>
            onChange({ ...value, contextFit: e.target.value as OllamaContextSettings['contextFit'] })
          }
        >
          <option value="fit">Fit to VRAM: shrink the window if the model spills to the CPU</option>
          <option value="max">Largest that fits: grow to what the VRAM holds</option>
          <option value="off">Exactly as set: never resize</option>
        </select>
      </label>
      <label className="field">
        <span>KV cache type (the server’s OLLAMA_KV_CACHE_TYPE)</span>
        <select
          value={value.kvCacheType ?? 'f16'}
          disabled={busy || fit === 'off'}
          onChange={(e) =>
            onChange({
              ...value,
              kvCacheType: e.target.value as OllamaContextSettings['kvCacheType']
            })
          }
        >
          <option value="f16">f16 (Ollama default)</option>
          <option value="q8_0">q8_0 (about half the memory)</option>
          <option value="q4_0">q4_0 (about a quarter)</option>
        </select>
      </label>
      <label className="field">
        <span>Total VRAM available to this server, GiB</span>
        <input
          type="number"
          min={1}
          max={4096}
          step={1}
          disabled={busy || fit !== 'max'}
          value={value.vramGiB ?? ''}
          placeholder="Auto for loopback servers"
          onChange={(e) => {
            const gib = Number(e.target.value)
            onChange({
              ...value,
              vramGiB: e.target.value && Number.isFinite(gib) && gib >= 1 ? Math.min(gib, 4096) : undefined
            })
          }}
        />
      </label>
      {fit === 'max' && (
        <p className="models-hint">
          Enter the combined VRAM of the GPUs assigned to this server. For a loopback server,
          blank estimates the total from this computer’s detected GPUs.
        </p>
      )}
      {onRemeasure && fit !== 'off' && (
        <button type="button" className="btn" disabled={busy} onClick={onRemeasure}>
          Re-measure windows
        </button>
      )}
    </div>
  )
}
