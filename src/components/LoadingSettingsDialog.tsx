import { useDialogFocus } from '@/hooks/useDialogFocus'
export function LoadingSettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useDialogFocus(onClose)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="modal settings-modal-loading"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-content">
          <h2>Settings</h2>
          <p role="status">Loading…</p>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
