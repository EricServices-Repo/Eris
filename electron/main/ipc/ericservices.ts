import { ipcMain, shell } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import {
  applyProfileBundle,
  buildEricServicesStatus,
  buildProfileBundle,
  buildSyncableSettings,
  ericServicesFetchMe,
  ericServicesLogin,
  ericServicesLogout,
  ericServicesPullSettings,
  ericServicesPushSettings,
  ericServicesTokenRef
} from '../services/ericservices'
import { syncMcpRuntime } from '../services/mcp-runtime'
import type { SettingsPatch } from '../../../src/shared/settings-schema'
import { appState } from '../app-state'
import { getSecret, storeSecret } from './shared'

function mergePulledUserSettings(
  remote: SettingsPatch,
  local: ReturnType<typeof getResolvedSettings>
): SettingsPatch {
  const patch: SettingsPatch = { ...remote }
  if (remote.mcp?.servers) {
    const localById = new Map((local.mcp?.servers || []).map((s) => [s.id, s]))
    patch.mcp = {
      servers: remote.mcp.servers.map((rs) => {
        if (!rs || typeof rs !== 'object' || !('id' in rs)) return rs as never
        const id = String((rs as { id: string }).id)
        const loc = localById.get(id)
        if (!loc) return rs as never
        const env = { ...((rs as { env?: Record<string, string> }).env || {}) }
        for (const [k, v] of Object.entries(loc.env || {})) {
          if (!env[k]) env[k] = v
        }
        return { ...(rs as object), env } as never
      })
    }
  }
  if (remote.models?.connections) {
    const localById = new Map((local.models?.connections || []).map((c) => [c.id, c]))
    patch.models = {
      ...(patch.models || {}),
      connections: remote.models.connections.map((rc) => {
        if (!rc || typeof rc !== 'object' || !('id' in rc)) return rc as never
        const id = String((rc as { id: string }).id)
        const loc = localById.get(id)
        if (!loc?.apiKeyRef) return { ...(rc as object), apiKeyRef: '' } as never
        return { ...(rc as object), apiKeyRef: loc.apiKeyRef } as never
      })
    }
  }
  return patch
}

export function registerEricServicesIpc(): void {
  ipcMain.handle('ericServices:status', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const token = settings.ericServices.tokenRef
      ? getSecret(settings.ericServices.tokenRef)
      : null
    const base = buildEricServicesStatus(settings, Boolean(token))
    if (!token || !settings.ericServices.linked) return base
    const me = await ericServicesFetchMe(settings.ericServices.apiBase, token)
    if (!me.ok) {
      return { ...base, ok: false, error: me.error }
    }
    if (me.profile) {
      setSettings(
        'user',
        {
          ericServices: {
            username: me.profile.username || settings.ericServices.username,
            email: me.profile.email || settings.ericServices.email
          }
        },
        appState.currentWorkspace
      )
    }
    return {
      ...buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true),
      profile: me.profile ?? null
    }
  })

  ipcMain.handle(
    'ericServices:login',
    async (
      _e,
      payload: { username: string; password: string; apiBase?: string; syncAfter?: boolean }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      const apiBase = payload.apiBase?.trim() || settings.ericServices.apiBase
      const username = payload.username?.trim() || ''
      const password = payload.password || ''
      if (!username || !password) {
        return { ok: false, error: 'Username and password are required' }
      }
      const result = await ericServicesLogin(apiBase, username, password, 'Eris')
      if (!result.ok || !result.token) {
        return { ok: false, error: result.error || 'Login failed' }
      }
      const ref = ericServicesTokenRef()
      storeSecret(ref, result.token)
      setSettings(
        'user',
        {
          ericServices: {
            apiBase,
            tokenRef: ref,
            linked: true,
            username: result.profile?.username || username,
            email: result.profile?.email || ''
          }
        },
        appState.currentWorkspace
      )

      let sync: { ok: boolean; error?: string; direction?: string } | undefined
      if (payload.syncAfter !== false && settings.ericServices.syncEnabled !== false) {
        sync = await syncEricServicesProfile('pull')
        if (!sync.ok) {
          // Push local prefs if nothing remote yet
          sync = await syncEricServicesProfile('push')
        }
      }

      return {
        ok: true,
        profile: result.profile,
        status: buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true, {
          profile: result.profile ?? null
        }),
        sync
      }
    }
  )

  ipcMain.handle('ericServices:logout', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const token = settings.ericServices.tokenRef
      ? getSecret(settings.ericServices.tokenRef)
      : null
    if (token) {
      await ericServicesLogout(settings.ericServices.apiBase, token).catch(() => undefined)
    }
    storeSecret(ericServicesTokenRef(), '')
    setSettings(
      'user',
      {
        ericServices: {
          tokenRef: '',
          linked: false,
          username: '',
          email: '',
          lastSyncedAt: ''
        }
      },
      appState.currentWorkspace
    )
    return buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), false)
  })

  async function syncEricServicesProfile(
    direction: 'pull' | 'push' | 'bidirectional'
  ): Promise<{
    ok: boolean
    error?: string
    direction?: string
    updatedAt?: string | null
    status?: ReturnType<typeof buildEricServicesStatus>
  }> {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const token = settings.ericServices.tokenRef
      ? getSecret(settings.ericServices.tokenRef)
      : null
    if (!token || !settings.ericServices.linked) {
      return { ok: false, error: 'Sign in to EricServic.es first' }
    }

    if (direction === 'pull' || direction === 'bidirectional') {
      const remote = await ericServicesPullSettings(settings.ericServices.apiBase, token)
      if (!remote.ok) return { ok: false, error: remote.error, direction: 'pull' }
      const applied = applyProfileBundle(remote.bundle)
      const settingsPatch = applied.settings || remote.settings
      if (settingsPatch && Object.keys(settingsPatch).length > 0) {
        const localResolved = getResolvedSettings(appState.currentWorkspace)
        setSettings(
          'user',
          mergePulledUserSettings(settingsPatch, localResolved),
          appState.currentWorkspace
        )
        setSettings(
          'user',
          {
            ericServices: {
              lastSyncedAt: remote.updatedAt || new Date().toISOString()
            }
          },
          appState.currentWorkspace
        )
        void syncMcpRuntime(getResolvedSettings(appState.currentWorkspace), appState.currentWorkspace).catch(
          () => undefined
        )
        return {
          ok: true,
          direction: 'pull',
          updatedAt: remote.updatedAt,
          status: buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true)
        }
      }
      if (applied.skillsImported > 0) {
        setSettings(
          'user',
          {
            ericServices: {
              lastSyncedAt: remote.updatedAt || new Date().toISOString()
            }
          },
          appState.currentWorkspace
        )
        return {
          ok: true,
          direction: 'pull',
          updatedAt: remote.updatedAt,
          status: buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true)
        }
      }
      if (direction === 'pull') {
        return {
          ok: true,
          direction: 'pull',
          updatedAt: null,
          status: buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true)
        }
      }
    }

    const resolved = getResolvedSettings(appState.currentWorkspace)
    const local = buildSyncableSettings(resolved)
    const bundle = buildProfileBundle(resolved)
    const pushed = await ericServicesPushSettings(
      settings.ericServices.apiBase,
      token,
      local,
      settings.ericServices.lastSyncedAt || null,
      bundle
    )
    if (!pushed.ok) {
      // Conflict: remote newer — pull instead when bidirectional
      if (direction === 'bidirectional' && (pushed.bundle || pushed.settings)) {
        const applied = applyProfileBundle(pushed.bundle)
        const settingsPatch = applied.settings || pushed.settings
        if (settingsPatch) {
          const localResolved = getResolvedSettings(appState.currentWorkspace)
          setSettings(
            'user',
            mergePulledUserSettings(settingsPatch, localResolved),
            appState.currentWorkspace
          )
        }
        setSettings(
          'user',
          {
            ericServices: {
              lastSyncedAt: pushed.updatedAt || new Date().toISOString()
            }
          },
          appState.currentWorkspace
        )
        void syncMcpRuntime(getResolvedSettings(appState.currentWorkspace), appState.currentWorkspace).catch(
          () => undefined
        )
        return {
          ok: true,
          direction: 'pull',
          updatedAt: pushed.updatedAt,
          status: buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true)
        }
      }
      return { ok: false, error: pushed.error, direction: 'push' }
    }
    setSettings(
      'user',
      {
        ericServices: {
          lastSyncedAt: pushed.updatedAt || new Date().toISOString()
        }
      },
      appState.currentWorkspace
    )
    return {
      ok: true,
      direction: 'push',
      updatedAt: pushed.updatedAt,
      status: buildEricServicesStatus(getResolvedSettings(appState.currentWorkspace), true)
    }
  }

  ipcMain.handle(
    'ericServices:sync',
    async (_e, direction?: 'pull' | 'push' | 'bidirectional') => {
      return syncEricServicesProfile(direction || 'bidirectional')
    }
  )

  ipcMain.handle('ericServices:openAccount', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const base = settings.ericServices.apiBase.replace(/\/+$/, '')
    const url = settings.ericServices.linked
      ? `${base}/account/eris.php`
      : `${base}/loginform.php`
    await shell.openExternal(url)
    return { ok: true, url }
  })
}
