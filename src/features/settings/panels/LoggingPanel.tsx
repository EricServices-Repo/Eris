import { useState } from 'react'
import type { AppSettings } from '@/shared/settings-schema'
import type { ApplySetting } from '../fields'
import { SettingsPage, SettingsSection } from '../SettingsSection'

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

export function LoggingPanel({
  state,
  resolved,
  apply
}: {
  state: LogsState
  resolved: AppSettings
  apply: ApplySetting
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
    <SettingsPage className="logging-page">
      <SettingsSection
        title="Storage"
        description="Daily log files for chat, models, workspace, and errors. Secrets in log text are not guaranteed redacted here — treat the folder as sensitive."
      >
        <div className="settings-inline-field">
          <div>
            <label>Log directory</label>
            <div className="hint">
              Empty uses the default Application Support folder. Current:{' '}
              <code>{logsInfo?.directory || '…'}</code>
            </div>
          </div>
          <div className="logs-path-controls">
            <input
              value={resolved.general.logging.directory}
              placeholder={logsInfo?.defaultDirectory || 'Default app logs folder'}
              onChange={(e) => void apply(['general', 'logging', 'directory'], e.target.value)}
            />
            <div className="settings-inline-actions">
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
              <button className="btn" type="button" onClick={() => void window.ide.openLogsFolder()}>
                Open folder
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Viewer"
        description="Newest entries at the bottom. Refresh after reproducing a bug."
        actions={
          <>
            <select
              value={selectedLogFile}
              onChange={(e) => {
                const name = e.target.value
                setSelectedLogFile(name)
                void loadLogs(name || undefined)
              }}
            >
              {(logsInfo?.files.length
                ? logsInfo.files
                : [{ name: selectedLogFile || 'today' }]
              ).map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                  {'size' in f && typeof f.size === 'number'
                    ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB`
                    : ''}
                </option>
              ))}
            </select>
            <button
              className="btn"
              type="button"
              disabled={logsLoading}
              onClick={() => void loadLogs(selectedLogFile || undefined)}
            >
              Refresh
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                if (
                  window.confirm('Clear all log files in this directory? This cannot be undone.')
                ) {
                  void window.ide.clearLogs().then(() => loadLogs())
                }
              }}
            >
              Clear logs
            </button>
          </>
        }
      >
        {logTruncated && (
          <div className="hint" style={{ marginBottom: 8 }}>
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
      </SettingsSection>
    </SettingsPage>
  )
}
