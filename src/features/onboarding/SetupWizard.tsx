import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BuiltinModelStatus } from '@/shared/settings-schema'
import logo from '@/assets/logo.png'

type StepId = 'welcome' | 'models' | 'workspace' | 'firstWin' | 'ready'

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'models', label: 'Models' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'firstWin', label: 'Try it' },
  { id: 'ready', label: 'Ready' }
]

interface Props {
  open: boolean
  onFinished: () => void
  onCreateWorkspace: () => void
  onLinkWorkspace: () => void
  hasWorkspace: boolean
  /** Start a guided first agent turn after setup */
  onStartFirstWin?: () => void
}

export function SetupWizard({
  open,
  onFinished,
  onCreateWorkspace,
  onLinkWorkspace,
  hasWorkspace,
  onStartFirstWin
}: Props) {
  const [step, setStep] = useState<StepId>('welcome')
  const [builtins, setBuiltins] = useState<BuiltinModelStatus[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshBuiltins = useCallback(async () => {
    const list = await window.ide.builtinModelStatus()
    setBuiltins(list)
    return list
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshBuiltins().catch(() => undefined)
    const off = window.ide.onBuiltinDownloadProgress((s) => {
      setBuiltins((prev) => {
        const idx = prev.findIndex((b) => b.id === s.id)
        if (idx < 0) return [...prev, s]
        const next = [...prev]
        next[idx] = s
        return next
      })
    })
    return () => off()
  }, [open, refreshBuiltins])

  const lite = useMemo(
    () => builtins.find((b) => b.id === 'composer-lite') || builtins.find((b) => b.tier === 'lite'),
    [builtins]
  )
  const full = useMemo(
    () => builtins.find((b) => b.id === 'composer') || builtins.find((b) => b.tier === 'full'),
    [builtins]
  )

  const stepIndex = STEPS.findIndex((s) => s.id === step)

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      if (lite?.ready) {
        await window.ide.setSettings('user', {
          models: { defaultModel: lite.ref || 'builtin:composer-lite' }
        })
      }
      await window.ide.completeOnboarding()
      onFinished()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish setup')
    } finally {
      setBusy(false)
    }
  }

  const downloadModel = async (id: string) => {
    setError(null)
    setDownloadingId(id)
    try {
      await window.ide.downloadBuiltinModel(id)
      await refreshBuiltins()
      if (id === 'composer-lite' || id.includes('lite')) {
        await window.ide.setSettings('user', {
          models: { defaultModel: 'builtin:composer-lite' }
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingId(null)
    }
  }

  if (!open) return null

  return (
    <div className="setup-wizard-backdrop" role="dialog" aria-modal="true" aria-label="Setup">
      <div className="setup-wizard">
        <div className="setup-wizard-glow" aria-hidden />
        <header className="setup-wizard-header">
          <div className="setup-wizard-brand">
            <img src={logo} alt="" className="setup-wizard-logo" draggable={false} />
            <div>
              <div className="setup-wizard-kicker">First-time setup</div>
              <h1>Get Eris ready</h1>
            </div>
          </div>
          <ol className="setup-wizard-steps" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={
                  s.id === step ? 'active' : i < stepIndex ? 'done' : undefined
                }
              >
                <span className="setup-step-index">{i + 1}</span>
                <span className="setup-step-label">{s.label}</span>
              </li>
            ))}
          </ol>
        </header>

        <div className="setup-wizard-body">
          {step === 'welcome' && (
            <section className="setup-panel">
              <h2>Local AI IDE, ready when you are</h2>
              <p>
                Eris runs Composer models on your Mac, edits project files with an agent, and keeps
                workspace settings in <code>.eris/</code>. This short setup downloads what you need
                and opens your first folder.
              </p>
              <ul className="setup-checklist">
                <li>Download Composer Lite for chat (~1 GB)</li>
                <li>Optionally add Composer Full for stronger agent edits</li>
                <li>Create or link a workspace folder</li>
              </ul>
            </section>
          )}

          {step === 'models' && (
            <section className="setup-panel">
              <h2>Install built-in models</h2>
              <p>
                Lite is the chat face and required for a smooth start. Full is the workspace worker
                for multi-file agent edits — download it when you have bandwidth.
              </p>
              <div className="setup-model-cards">
                {[lite, full].filter(Boolean).map((b) => {
                  const model = b!
                  const sizeLabel =
                    model.approxBytes >= 1e9
                      ? `~${(model.approxBytes / 1e9).toFixed(1)} GB`
                      : `~${Math.round(model.approxBytes / 1e6)} MB`
                  const isDownloading = downloadingId === model.id
                  const progress = Math.round((model.progress || 0) * 100)
                  return (
                    <div
                      key={model.id}
                      className={`setup-model-card${model.ready ? ' ready' : ''}${
                        model.tier === 'lite' ? ' featured' : ''
                      }`}
                    >
                      <div className="setup-model-card-top">
                        <strong>{model.displayName}</strong>
                        <span className="badge">{model.tier === 'lite' ? 'recommended' : 'optional'}</span>
                      </div>
                      <p>{model.description || `${model.family} · ${model.parameters}`}</p>
                      <div className="setup-model-meta">
                        {model.ready
                          ? 'Ready on this Mac'
                          : isDownloading
                            ? `Downloading… ${progress}%`
                            : `Not installed · ${sizeLabel}`}
                      </div>
                      {(isDownloading || (model.progress > 0 && model.progress < 1)) && (
                        <div className="setup-progress">
                          <div style={{ width: `${Math.max(4, progress)}%` }} />
                        </div>
                      )}
                      <div className="setup-model-actions">
                        {model.ready ? (
                          <span className="setup-ready-pill">Installed</span>
                        ) : isDownloading ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void window.ide.cancelBuiltinDownload()}
                          >
                            Cancel
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={`btn${model.tier === 'lite' ? ' btn-primary' : ''}`}
                            disabled={Boolean(downloadingId)}
                            onClick={() => void downloadModel(model.id)}
                          >
                            {model.installed ? 'Re-download' : 'Download'} ({sizeLabel})
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              {!lite && (
                <p className="model-conn-hint">Loading model catalog…</p>
              )}
            </section>
          )}

          {step === 'workspace' && (
            <section className="setup-panel">
              <h2>Open a workspace</h2>
              <p>
                A workspace is just a project folder. Agent tools, terminal, verify, and git all run
                inside it. You can add more later from the Explorer.
              </p>
              {hasWorkspace ? (
                <div className="setup-success-banner">Workspace linked — you can continue.</div>
              ) : (
                <div className="setup-workspace-actions">
                  <button type="button" className="btn btn-primary" onClick={onCreateWorkspace}>
                    New workspace…
                  </button>
                  <button type="button" className="btn" onClick={onLinkWorkspace}>
                    Link existing folder…
                  </button>
                </div>
              )}
              <p className="model-conn-hint" style={{ marginTop: 14 }}>
                Tip: you can skip this step and open a folder anytime with ⌘O.
              </p>
            </section>
          )}

          {step === 'firstWin' && (
            <section className="setup-panel">
              <h2>Your first win</h2>
              <p>
                After setup, Eris can open a chat with a starter prompt: ask the agent to scan the
                workspace and suggest one small improvement. Review the diff, Keep the change, then
                you&apos;re shipping.
              </p>
              <ul className="setup-checklist">
                <li>Composer Lite answers in chat</li>
                <li>Agent mode can propose file edits</li>
                <li>Diff Review lets you Keep or Undo each file</li>
              </ul>
              {!hasWorkspace && (
                <p className="model-conn-hint">
                  Link a workspace on the previous step for the best first run.
                </p>
              )}
            </section>
          )}

          {step === 'ready' && (
            <section className="setup-panel">
              <h2>You&apos;re set</h2>
              <p>A few shortcuts to remember:</p>
              <div className="setup-tips">
                <div>
                  <kbd>⌘L</kbd>
                  <span>New agent chat</span>
                </div>
                <div>
                  <kbd>⌘⇧P</kbd>
                  <span>Command palette</span>
                </div>
                <div>
                  <kbd>⌘,</kbd>
                  <span>Settings (models, skills, sync)</span>
                </div>
                <div>
                  <kbd>⌘↵</kbd>
                  <span>Send chat message</span>
                </div>
              </div>
              <ul className="setup-checklist">
                <li>
                  Composer Lite:{' '}
                  {lite?.ready ? 'ready' : 'not installed — chat will ask you to download'}
                </li>
                <li>
                  Composer Full:{' '}
                  {full?.ready ? 'ready for agent work' : 'optional — install later in Settings → Models'}
                </li>
                <li>Workspace: {hasWorkspace ? 'open' : 'open one when you start a project'}</li>
              </ul>
            </section>
          )}

          {error && (
            <p className="model-conn-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {error}
            </p>
          )}
        </div>

        <footer className="setup-wizard-footer">
          <button
            type="button"
            className="btn"
            disabled={busy || Boolean(downloadingId)}
            onClick={() => void finish()}
          >
            Skip for now
          </button>
          <div className="setup-wizard-footer-right">
            {stepIndex > 0 && (
              <button
                type="button"
                className="btn"
                disabled={busy || Boolean(downloadingId)}
                onClick={() => setStep(STEPS[stepIndex - 1]!.id)}
              >
                Back
              </button>
            )}
            {step !== 'ready' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || Boolean(downloadingId)}
                onClick={() => {
                  if (step === 'models' && lite && !lite.ready) {
                    const go = window.confirm(
                      'Composer Lite is not installed yet. Continue without downloading?'
                    )
                    if (!go) return
                  }
                  setStep(STEPS[stepIndex + 1]!.id)
                }}
              >
                Continue
              </button>
            ) : (
              <>
                {onStartFirstWin && hasWorkspace && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      void finish().then(() => onStartFirstWin())
                    }}
                  >
                    Start guided chat
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void finish()}
                >
                  {busy ? 'Finishing…' : 'Start using Eris'}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
