import { BugReportForm } from './BugReportForm'

interface Props {
  open: boolean
  onClose: () => void
}

export function BugReportModal({ open, onClose }: Props) {
  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal bug-report-modal"
        style={{
          width: 'min(560px, 94vw)',
          height: 'auto',
          maxHeight: 'min(88vh, 760px)',
          gridTemplateColumns: '1fr',
          padding: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '18px 20px 4px' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Send feedback</h2>
        </div>
        <div style={{ padding: '4px 20px 16px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          <BugReportForm variant="modal" onClose={onClose} />
        </div>
      </div>
    </div>
  )
}
