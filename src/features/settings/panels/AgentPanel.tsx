import { useCallback, useEffect, useState } from 'react'
import type { CloudHealth } from '@/shared/cloud-agents'
import {
  CLOUD_AGENTS_BASE_URL,
  cloudAgentsStatusLabel,
  isCloudAgentsReady,
  shouldUseCloudAgents
} from '@/shared/cloud-agents'
import { SettingsPage, SettingsSection } from '../SettingsSection'

function offlineHealth(error: string): CloudHealth {
  return {
    ok: false,
    authenticated: false,
    service: 'eris-cloud-agent',
    version: '',
    llmConfigured: false,
    maxParallel: 0,
    running: 0,
    queued: 0,
    error
  }
}

export function AgentPanel() {
  const [cloud, setCloud] = useState<CloudHealth | null>(null)
  const [busy, setBusy] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const [clearMsg, setClearMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const health = await window.ide.cloudAgentsHealth()
      setCloud(health)
    } catch (err) {
      setCloud(offlineHealth(err instanceof Error ? err.message : 'Unreachable'))
    } finally {
      setBusy(false)
    }
  }, [])

  const stopAllMine = useCallback(async () => {
    if (
      !window.confirm(
        'Stop all of your queued and running Cloud Agent jobs?\n\nThis only affects your account, not other users.'
      )
    ) {
      return
    }
    setClearBusy(true)
    setClearMsg(null)
    try {
      const result = await window.ide.stopAllCloudJobs()
      setClearMsg(
        result.count === 0
          ? 'No active Cloud jobs for your account.'
          : `Stopped ${result.count} Cloud job${result.count === 1 ? '' : 's'}.`
      )
      await refresh()
    } catch (err) {
      setClearMsg(err instanceof Error ? err.message : 'Failed to stop Cloud jobs')
    } finally {
      setClearBusy(false)
    }
  }, [refresh])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(id)
  }, [refresh])

  const ready = isCloudAgentsReady(cloud)
  const preferCloud = shouldUseCloudAgents(cloud)
  const label = cloudAgentsStatusLabel(cloud)
  const host = CLOUD_AGENTS_BASE_URL.replace(/^https?:\/\//, '')

  return (
    <SettingsPage>
      <SettingsSection
        title="Routing"
        description="Picks an orchestrator or specialist from the project agent config. Edit specialists under Subagents."
      />

      <SettingsSection
        title="Cloud Agents"
        description={`Shared worker at ${host} runs Composer Full. Sign in under Account. This Mac uses Composer Lite locally; Cloud Agents handle Full when available.`}
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={clearBusy || cloud?.authenticated !== true}
              title="Stop all of your queued and running Cloud jobs"
              onClick={() => void stopAllMine()}
            >
              {clearBusy ? 'Stopping…' : 'Stop all my jobs'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
              {busy ? 'Checking…' : 'Refresh'}
            </button>
          </>
        }
      >
        <div
          className={`agents-cloud-status${ready ? ' is-ready' : preferCloud ? ' is-pending' : ' is-offline'}`}
          title={`${CLOUD_AGENTS_BASE_URL} — TLS`}
          style={{ marginBottom: 12 }}
        >
          <span className={`status-dot${preferCloud ? ' ok' : ''}`} />
          <span>{label}</span>
          <span className="agents-cloud-host">{host}</span>
        </div>

        <div className="usage-hero">
          <div className="usage-hero-card">
            <div className="usage-hero-label">Status</div>
            <div className="usage-hero-value" style={{ fontSize: 18 }}>
              {ready ? 'Ready' : preferCloud ? 'Warming' : 'Offline'}
            </div>
            <div className="usage-hero-sub">
              {cloud?.authenticated !== true
                ? 'sign in required · Account'
                : preferCloud
                  ? cloud?.inference === 'remote'
                    ? 'remote inference · prefer cloud'
                    : 'local GGUF · prefer cloud'
                  : 'fallback to local worktrees'}
            </div>
          </div>
          <div className="usage-hero-card">
            <div className="usage-hero-label">Running</div>
            <div className="usage-hero-value">{cloud?.running ?? '—'}</div>
            <div className="usage-hero-sub">max {cloud?.maxParallel ?? '—'}</div>
          </div>
          <div className="usage-hero-card">
            <div className="usage-hero-label">Queued</div>
            <div className="usage-hero-value">{cloud?.queued ?? '—'}</div>
            <div className="usage-hero-sub">waiting on worker</div>
          </div>
          <div className="usage-hero-card">
            <div className="usage-hero-label">Model</div>
            <div className="usage-hero-value" style={{ fontSize: 15 }}>
              {cloud?.localModel?.modelName || cloud?.localModel?.status || '—'}
            </div>
            <div className="usage-hero-sub">
              {cloud?.localModel?.status || (cloud?.llmConfigured ? 'configured' : 'n/a')}
              {cloud?.localModel?.gpu === false
                ? ' · CPU'
                : cloud?.localModel?.gpu
                  ? ` · GPU ${cloud.localModel.gpu}`
                  : cloud?.gpuMode
                    ? ` · gpu=${cloud.gpuMode}`
                    : ''}
              {cloud?.version ? ` · v${cloud.version}` : ''}
            </div>
          </div>
        </div>

        {clearMsg && (
          <div className="settings-hint" style={{ marginTop: 12 }}>
            {clearMsg}
          </div>
        )}
        {cloud?.error && (
          <div className="git-error" style={{ marginTop: 12 }}>
            {cloud.error}
          </div>
        )}
        {cloud?.localModel?.error && (
          <div className="git-error" style={{ marginTop: 12 }}>
            Model: {cloud.localModel.error}
          </div>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}
