/**
 * Keeps the hosted "Eris Cloud" Ollama connection in step with the EricServic.es
 * account: on after sign-in when the server offers hosted models, off after sign-out.
 * The user can still turn it off in Settings → Providers; a status refresh only
 * turns it off (when the server stops offering it), never back on.
 */
import { appState } from '../app-state'
import { getResolvedSettings, setSettings } from './settings'
import { ericServicesFetchMe } from './ericservices'
import { logInfo, logWarn } from './logger'
import {
  ERIS_CLOUD_CONNECTION_ID,
  normalizeErisCloudConnection,
  type ErisHostedModels
} from '../../../src/shared/eris-cloud'

export function setErisCloudEnabled(enabled: boolean): void {
  const settings = getResolvedSettings(appState.currentWorkspace)
  const connections = settings.models.connections
  const idx = connections.findIndex((c) => c.id === ERIS_CLOUD_CONNECTION_ID)
  // settings sanitize always creates the connection; nothing to do if it is missing.
  if (idx < 0) return
  const current = connections[idx]!
  if (current.enabled === enabled) return
  const next = connections.map((c, i) =>
    i === idx ? normalizeErisCloudConnection({ ...c, enabled }) : c
  )
  setSettings('user', { models: { connections: next } }, appState.currentWorkspace)
  logInfo('Eris Cloud connection toggled', { enabled })
}

/** After a successful sign-in: enable Eris Cloud if the account's server offers it. */
export async function enableErisCloudAfterSignIn(apiBase: string, token: string): Promise<void> {
  try {
    const me = await ericServicesFetchMe(apiBase, token)
    if (me.ok && me.hostedModels?.enabled) setErisCloudEnabled(true)
  } catch (err) {
    logWarn('Eris Cloud sign-in check failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** On a /me refresh: only switch off when the server explicitly stopped offering it. */
export function applyHostedModelsRefresh(hosted: ErisHostedModels | null | undefined): void {
  if (hosted && !hosted.enabled) setErisCloudEnabled(false)
}
