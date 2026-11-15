import { ModelSetupCard } from './ModelSetupCard'
import { useDialogFocus } from '@/hooks/useDialogFocus'

interface Props {
  open: boolean
  onFinished: () => void
  onCreateWorkspace: () => void
  onLinkWorkspace: () => void
  hasWorkspace: boolean
  hasReadyModel?: boolean
  onOpenModelsSettings: () => void
  onOpenProviders: () => void
  onModelsChanged: () => Promise<void>
  /** Start a guided first agent turn after setup */
  onStartFirstWin?: () => void
}

export function SetupWizard({ open, onFinished, onCreateWorkspace, onLinkWorkspace, hasWorkspace, hasReadyModel, onOpenModelsSettings, onOpenProviders, onModelsChanged, onStartFirstWin }: Props) {
  const dialogRef = useDialogFocus(onFinished)
  if (!open) return null
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label="Welcome to Eris" ref={dialogRef}>
    <h2>Welcome to Eris</h2>
    {!hasReadyModel && <ModelSetupCard onChanged={onModelsChanged} onOpenModels={onOpenModelsSettings} onOpenProviders={onOpenProviders} />}
    {!hasWorkspace && <><button onClick={onCreateWorkspace}>Create workspace</button><button onClick={onLinkWorkspace}>Open workspace</button></>}
    {hasWorkspace && hasReadyModel && onStartFirstWin && <button onClick={onStartFirstWin}>Try an agent task</button>}
    <button onClick={onFinished}>Continue</button>
  </div></div>
}
