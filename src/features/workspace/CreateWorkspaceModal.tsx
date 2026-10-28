import { useDialogFocus } from '@/hooks/useDialogFocus'
import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  mode: 'create' | 'link'
  onClose: () => void
  onSubmit: (name: string) => void
}

export function CreateWorkspaceModal({ open, mode, onClose, onSubmit }: Props) {
  const dialogRef = useDialogFocus(onClose)
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) setName('')
  }, [open, mode])

  if (!open) return null

  const title = mode === 'create' ? 'New Workspace' : 'Link Folder as Workspace'
  const hint =
    mode === 'create'
      ? 'Creates a new folder linked to this workspace, with .eris config inside.'
      : 'Registers an existing folder as a named workspace. Optional display name below.'
  const cta = mode === 'create' ? 'Choose Location…' : 'Choose Folder…'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace"
        tabIndex={-1}
        style={{
          width: 'min(420px, 92vw)',
          height: 'auto',
          gridTemplateColumns: '1fr',
          padding: 0
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '20px 22px' }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>{title}</h2>
          <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', lineHeight: 1.45 }}>{hint}</p>
          <label
            htmlFor="workspace-name"
            style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}
          >
            Workspace name{mode === 'link' ? ' (optional)' : ''}
          </label>
          <input
            id="workspace-name"
            value={name}
            placeholder={mode === 'create' ? 'My Project' : 'Uses folder name if empty'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'Enter' && (mode === 'link' || name.trim())) {
                e.preventDefault()
                onSubmit(name.trim())
              }
            }}
            style={{ width: '100%', marginBottom: 16 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={mode === 'create' && !name.trim()}
              onClick={() => onSubmit(name.trim())}
            >
              {cta}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
