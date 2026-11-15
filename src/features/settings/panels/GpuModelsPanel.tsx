import { useState } from 'react'
import type { AppSettings, GpuDeviceInfo, ModelsStatus } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { InferenceAdmission } from '../InferenceAdmission'
import './gpu-models.css'

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function memory(bytes: number | undefined): string {
  if (bytes === undefined) return 'Unavailable'
  return bytes >= 1024 ** 3
    ? `${numberFormat.format(bytes / 1024 ** 3)} GiB`
    : `${numberFormat.format(bytes / 1024 ** 2)} MiB`
}

function DeviceCard({ device, preferred }: { device: GpuDeviceInfo; preferred: boolean }) {
  const integrated = device.kind === 'integrated'
  const unified = /apple\s+m\d/i.test(device.name)
  const memoryLabel = unified ? 'Unified memory' : integrated ? 'Graphics memory' : 'VRAM'
  const total = device.vramBytes
  const free = device.vramFreeBytes
  const freePercent =
    total && free !== undefined ? Math.min(100, Math.max(0, (free / total) * 100)) : null

  return (
    <article className="gpu-hardware-card">
      <div className="gpu-hardware-art" data-integrated={integrated} aria-hidden="true">
        {integrated ? (
          <div className="gpu-chip">
            <span className="gpu-chip-die" />
          </div>
        ) : (
          <div className="gpu-board">
            <span className="gpu-fan" />
            <span className="gpu-fan" />
          </div>
        )}
      </div>
      <div className="gpu-device-data">
        <div className="gpu-device-tags">
          <span>
            {integrated ? 'Integrated' : device.kind === 'external' ? 'External' : 'Discrete'}
          </span>
          {preferred && <span className="gpu-badge-preferred">Preferred</span>}
          {device.shared && <span>Shared VRAM</span>}
        </div>
        <h4>{device.name}</h4>
        {device.bus && (
          <p className="gpu-device-bus" title={device.bus}>
            {device.bus}
          </p>
        )}
        <dl className="gpu-device-memory">
          <div>
            <dt>{memoryLabel}</dt>
            <dd>{memory(total)}</dd>
          </div>
          {free !== undefined && (
            <div>
              <dt>Free memory</dt>
              <dd>{memory(free)}</dd>
            </div>
          )}
        </dl>
        {freePercent !== null && (
          <div className="gpu-memory-meter" aria-hidden="true">
            <span style={{ width: `${freePercent}%` }} />
          </div>
        )}
      </div>
    </article>
  )
}

export function GpuModelsPanel({
  resolved,
  status,
  apply,
  load
}: {
  resolved: AppSettings
  status: ModelsStatus | null
  apply: ApplySetting
  load: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const gpu = status?.gpu
  const devices = gpu?.devices ?? []
  const preferred = gpu?.preferredGpu
  const preferBest = resolved.models.preferEgpu !== false
  const loaded = gpu?.loadedModel
  const cpuLayers =
    loaded?.totalLayers !== undefined && loaded.gpuLayers !== undefined
      ? Math.max(0, loaded.totalLayers - loaded.gpuLayers)
      : null
  const backendLabels = { metal: 'Metal', cuda: 'CUDA', vulkan: 'Vulkan' }
  const backend = gpu?.backend ? backendLabels[gpu.backend] : 'CPU'

  async function refresh(change?: { setting: 'preferEgpu' | 'allowCpuSpill'; value: boolean }) {
    setBusy(true)
    setError('')
    try {
      if (change) await apply(['models', change.setting], change.value)
      await window.ide.reloadLlamaGpu()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh GPU status.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="models-page gpu-dashboard">
      <section className="models-card gpu-dashboard-hardware">
        <header className="models-card-head">
          <div>
            <h3>Graphics hardware</h3>
            <p>{gpu ? gpu.message : 'GPU detection results will appear here.'}</p>
          </div>
          <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Scanning…' : 'Rescan'}
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {gpu && (
          <dl className="gpu-dashboard-metrics">
            <div>
              <dt>Inference backend</dt>
              <dd>{gpu.accelUsable ? backend : 'CPU'}</dd>
            </div>
            <div>
              <dt>Model memory budget</dt>
              <dd>{memory(gpu.vramBudgetBytes)}</dd>
            </div>
            <div>
              <dt>Detected GPUs</dt>
              <dd>{devices.length}</dd>
            </div>
          </dl>
        )}
        <div className="gpu-hardware-grid">
          {devices.map((device) => (
            <DeviceCard
              key={`${device.index}:${device.name}`}
              device={device}
              preferred={
                preferBest && preferred?.index === device.index && preferred.name === device.name
              }
            />
          ))}
        </div>
        {gpu && devices.length === 0 && <p className="models-hint">No GPUs detected.</p>}
        {gpu?.vramShareTotalBytes !== undefined && devices.filter((d) => d.shared).length > 1 && (
          <p className="models-hint">
            Shared VRAM {memory(gpu.vramShareTotalBytes)}
            {gpu.vramShareFreeBytes !== undefined && ` · ${memory(gpu.vramShareFreeBytes)} free`}
          </p>
        )}
      </section>

      <section className="models-card">
        <header className="models-card-head">
          <h3>Local model placement</h3>
        </header>
        {loaded ? (
          <>
            <dl className="gpu-dashboard-metrics">
              <div>
                <dt>Context window</dt>
                <dd>{numberFormat.format(loaded.contextSize)} tokens</dd>
              </div>
              <div>
                <dt>GPU layers</dt>
                <dd>
                  {loaded.gpuLayers ?? 'Unavailable'}
                  {loaded.totalLayers !== undefined &&
                    loaded.gpuLayers !== undefined &&
                    ` / ${loaded.totalLayers}`}
                </dd>
              </div>
              <div>
                <dt>KV cache</dt>
                <dd>{memory(loaded.kvBytes)}</dd>
              </div>
            </dl>
            {(loaded.device || (cpuLayers !== null && cpuLayers > 0)) && (
              <p className="models-hint">
                {[loaded.device, cpuLayers ? `${cpuLayers} layers on CPU` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </>
        ) : (
          <p className="models-hint">No local GGUF model loaded.</p>
        )}
      </section>

      <section className="models-card">
        <header className="models-card-head">
          <h3>Placement preferences</h3>
        </header>
        <label className="gpu-accel-toggle">
          <input
            type="checkbox"
            checked={preferBest}
            disabled={busy}
            onChange={(e) => void refresh({ setting: 'preferEgpu', value: e.target.checked })}
          />
          <span>Prefer best GPU</span>
        </label>
        <label className="gpu-accel-toggle">
          <input
            type="checkbox"
            checked={resolved.models.allowCpuSpill !== false}
            disabled={busy}
            onChange={(e) => void refresh({ setting: 'allowCpuSpill', value: e.target.checked })}
          />
          <span>Allow CPU layers when a model cannot fit on the GPU</span>
        </label>
      </section>

      <div className="models-card gpu-queue">
        <InferenceAdmission />
      </div>
    </div>
  )
}
