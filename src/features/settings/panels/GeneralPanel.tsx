import { useState } from 'react'
import type { AppSettings } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'

export function useLogsState() {
  const [logsInfo, setLogsInfo] = useState<Awaited<ReturnType<typeof window.ide.getLogsInfo>> | null>(
    null
  )
  const [logContent, setLogContent] = useState('')
  const [logPath, setLogPath] = useState('')
  const [logTruncated, setLogTruncated] = useState(false)
  const [selectedLogFile, setSelectedLogFile] = useState<string>('')
  const [logsLoading, setLogsLoading] = useState(false)

  const loadLogs = async (fileName?: string) => {
    setLogsLoading(true)
    try {
      const [info, file] = await Promise.all([
        window.ide.getLogsInfo(),
        window.ide.readLogs(fileName || undefined)
      ])
      setLogsInfo(info)
      setLogContent(file.content)
      setLogPath(file.path)
      setLogTruncated(file.truncated)
      const name = file.path.split('/').pop() || ''
      setSelectedLogFile(name)
    } finally {
      setLogsLoading(false)
    }
  }

  return {
    logsInfo,
    logContent,
    logPath,
    logTruncated,
    selectedLogFile,
    setSelectedLogFile,
    logsLoading,
    loadLogs
  }
}

export type LogsState = ReturnType<typeof useLogsState>

export function GeneralPanel({
  state,
  resolved,
  apply,
  onClose,
  onRerunSetup
}: {
  state: LogsState
  resolved: AppSettings
  apply: ApplySetting
  onClose: () => void
  onRerunSetup?: () => void
}) {
  const {
    logsInfo,
    logContent,
    logPath,
    logTruncated,
    selectedLogFile,
    setSelectedLogFile,
    logsLoading,
    loadLogs
  } = state
  return (
    <div className="logs-panel">
      {onRerunSetup && (
        <div className="github-section" style={{ marginBottom: 16 }}>
          <h3>Setup wizard</h3>
          <p className="model-conn-hint">
            Re-run the first-time guide to download Composer models and open a workspace.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClose()
              onRerunSetup()
            }}
          >
            Run setup wizard again
          </button>
        </div>
      )}

      <div className="github-section" style={{ marginBottom: 16 }}>
        <h3>Updates</h3>
        <p className="model-conn-hint">
          Eris checks{' '}
          <code>github.com/EricServices-Repo/Eris/releases</code> for new builds (macOS zip +
          Windows setup). Signed releases install automatically; otherwise use Open releases.
        </p>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={resolved.general.updates?.autoCheck !== false}
            onChange={(e) => void apply(['general', 'updates', 'autoCheck'], e.target.checked)}
          />
          <span>Check for updates automatically</span>
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={resolved.general.updates?.autoDownload !== false}
            onChange={(e) => void apply(['general', 'updates', 'autoDownload'], e.target.checked)}
          />
          <span>Download updates in the background</span>
        </label>
        <div className="model-conn-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void window.ide.checkForAppUpdates(false)}
          >
            Check for updates
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void window.ide.openAppReleasesPage()}
          >
            Open releases
          </button>
        </div>
      </div>

      <div className="logs-panel-header">
        <strong>App logs</strong>
        <span className="hint">
          {logsInfo
            ? `Writing to ${logsInfo.directory}`
            : 'Daily log files for chat, models, and workspace events'}
        </span>
      </div>

      <div className="setting-row" style={{ border: 'none', padding: '8px 0' }}>
        <div>
          <label>Log directory</label>
          <div className="hint">
            Leave empty for the default folder under Application Support. Current:{' '}
            <code>{logsInfo?.directory || '…'}</code>
          </div>
        </div>
        <div className="logs-path-controls">
          <input
            value={resolved.general.logging.directory}
            placeholder={logsInfo?.defaultDirectory || 'Default app logs folder'}
            onChange={(e) => void apply(['general', 'logging', 'directory'], e.target.value)}
          />
          <button
            className="btn"
            type="button"
            onClick={() =>
              void window.ide.pickLogsDirectory().then(async (dir) => {
                if (!dir) return
                await apply(['general', 'logging', 'directory'], dir)
                await loadLogs()
              })
            }
          >
            Browse…
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              void apply(['general', 'logging', 'directory'], '').then(() => loadLogs())
            }
          >
            Use default
          </button>
        </div>
      </div>

      <div className="logs-toolbar">
        <select
          value={selectedLogFile}
          onChange={(e) => {
            const name = e.target.value
            setSelectedLogFile(name)
            void loadLogs(name || undefined)
          }}
        >
          {(logsInfo?.files.length ? logsInfo.files : [{ name: selectedLogFile || 'today' }]).map(
            (f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {'size' in f && typeof f.size === 'number'
                  ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB`
                  : ''}
              </option>
            )
          )}
        </select>
        <button className="btn" type="button" disabled={logsLoading} onClick={() => void loadLogs(selectedLogFile || undefined)}>
          Refresh
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => void window.ide.openLogsFolder()}
        >
          Open folder
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            if (
              window.confirm(
                'Clear all log files in this directory? This cannot be undone.'
              )
            ) {
              void window.ide.clearLogs().then(() => loadLogs())
            }
          }}
        >
          Clear logs
        </button>
      </div>

      {logTruncated && (
        <div className="hint" style={{ marginBottom: 6 }}>
          Showing the end of the file (truncated for display).
        </div>
      )}
      <pre className="logs-viewer" title={logPath}>
        {logsLoading
          ? 'Loading…'
          : logContent.trim()
            ? logContent
            : 'No log entries yet. Use the app (chat, workspaces, settings) and refresh.'}
      </pre>
    </div>
  )
}
