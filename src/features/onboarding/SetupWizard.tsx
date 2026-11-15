import { useDialogFocus } from '@/hooks/useDialogFocus'

interface Props {
  open: boolean
  onFinished: () => void
  onCreateWorkspace: () => void
  onLinkWorkspace: () => void
  hasWorkspace: boolean
  hasReadyModel?: boolean
  onOpenModelsSettings?: () => void
  /** Start a guided first agent turn after setup */
  onStartFirstWin?: () => void
}

export function SetupWizard({ open, onFinished, onCreateWorkspace, onLinkWorkspace, hasWorkspace, hasReadyModel, onOpenModelsSettings, onStartFirstWin }: Props) {
  const dialogRef = useDialogFocus(onFinished)
  if (!open) return null
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label="Welcome to Eris" ref={dialogRef}>
    <h2>Welcome to Eris</h2>
    <p>Download a local model or connect a provider in Settings. Auto selects an available model for each task; you can also select a specific model in chat.</p>
    <p>Eris Cloud models are hosted by EricServic.es. Sign in to your account and they appear under Settings → Providers.</p>
    <button onClick={onOpenModelsSettings}>Configure models</button>
    {!hasWorkspace && <><button onClick={onCreateWorkspace}>Create workspace</button><button onClick={onLinkWorkspace}>Open workspace</button></>}
    {hasWorkspace && hasReadyModel && onStartFirstWin && <button onClick={onStartFirstWin}>Try an agent task</button>}
    <button onClick={onFinished}>Continue</button>
  </div></div>
}
