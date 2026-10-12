import type { UpdateStatusSnapshot } from '@/shared/api'

interface Props {
  status: UpdateStatusSnapshot | null
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
  onOpenReleases: () => void
  onDismiss: () => void
}

function progressLabel(status: UpdateStatusSnapshot): string {
  if (status.state === 'downloading' && typeof status.percent === 'number') {
    return `${Math.round(status.percent)}%`
  }
  return ''
}

export function UpdateBanner({
  status,
  onCheck,
  onDownload,
  onInstall,
  onOpenReleases,
  onDismiss
}: Props) {
  if (!status) return null
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'downloaded' &&
    status.state !== 'error'
  ) {
    return null
  }

  const tone =
    status.state === 'error' ? 'danger' : status.state === 'downloaded' ? 'info' : 'warn'

  const manualOnly = Boolean(status.manualInstallOnly)
  let title = 'Update available'
  let detail: string | undefined
  if (status.state === 'available') {
    title = `Eris ${status.availableVersion} is available`
    detail = manualOnly
      ? `You are on v${status.currentVersion}. This build isn’t code-signed — download the installer from Releases.`
      : `You are on v${status.currentVersion}`
  } else if (status.state === 'downloading') {
    title = `Downloading Eris ${status.availableVersion || ''}…`
    detail = progressLabel(status) || 'Downloading from GitHub Releases'
  } else if (status.state === 'downloaded') {
    title = `Eris ${status.availableVersion} ready to install`
    detail = 'Restart to finish the update'
  } else if (status.state === 'error') {
    title = 'Could not update automatically'
    detail = status.error
  }

  return (
    <div className="conn-strip update-banner" role="status">
      <div className={`conn-strip-item tone-${tone}`}>
        <div className="conn-strip-copy">
          <strong>{title}</strong>
          {detail && <span>{detail}</span>}
        </div>
        <div className="conn-strip-actions">
          {status.state === 'available' && manualOnly && (
            <button type="button" className="btn btn-primary" onClick={onOpenReleases}>
              Open releases
            </button>
          )}
          {status.state === 'available' && !manualOnly && !status.autoDownload && (
            <button type="button" className="btn btn-primary" onClick={onDownload}>
              Download
            </button>
          )}
          {status.state === 'available' && !manualOnly && status.autoDownload && (
            <button type="button" className="btn" onClick={onCheck}>
              Check again
            </button>
          )}
          {status.state === 'downloaded' && (
            <button type="button" className="btn btn-primary" onClick={onInstall}>
              Restart &amp; install
            </button>
          )}
          {status.state === 'error' && (
            <button type="button" className="btn btn-primary" onClick={onOpenReleases}>
              Open releases
            </button>
          )}
          {status.state === 'available' && !manualOnly && (
            <button type="button" className="btn" onClick={onOpenReleases}>
              Notes
            </button>
          )}
          {status.state === 'downloaded' && (
            <button type="button" className="btn" onClick={onOpenReleases}>
              Notes
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
