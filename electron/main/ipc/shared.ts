import { safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { getResolvedSettings } from '../services/settings'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../services/workspace-watcher'
import { disposeMcpRuntime, syncMcpRuntime } from '../services/mcp-runtime'
import { ensureCodeIndex } from '../services/code-index'
import { disposePtySession } from '../services/pty-session'
import { disposeLanguageServers, configureLanguageServers } from '../services/language-servers'
import { userDataRoot } from '../services/paths'
import { appState } from '../app-state'

const secretsPath = (): string => join(userDataRoot(), 'secrets.bin')

export function storeSecret(key: string, value: string): void {
  mkdirSync(userDataRoot(), { recursive: true })
  let map: Record<string, string> = {}
  if (existsSync(secretsPath())) {
    try {
      const buf = readFileSync(secretsPath())
      if (safeStorage.isEncryptionAvailable()) {
        map = JSON.parse(safeStorage.decryptString(buf))
      } else {
        map = JSON.parse(buf.toString('utf8'))
      }
    } catch {
      map = {}
    }
  }
  map[key] = value
  const payload = JSON.stringify(map)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(secretsPath(), safeStorage.encryptString(payload))
  } else {
    writeFileSync(secretsPath(), payload, 'utf8')
  }
}

export function getSecret(key: string): string | null {
  if (!existsSync(secretsPath())) return null
  try {
    const buf = readFileSync(secretsPath())
    const map = safeStorage.isEncryptionAvailable()
      ? (JSON.parse(safeStorage.decryptString(buf)) as Record<string, string>)
      : (JSON.parse(buf.toString('utf8')) as Record<string, string>)
    return map[key] ?? null
  } catch {
    return null
  }
}

export const refreshIntelligence = () => {
  disposePtySession()
  void disposeLanguageServers()
  if (!appState.currentWorkspace) {
    stopWorkspaceWatcher()
    void disposeMcpRuntime()
    return
  }
  startWorkspaceWatcher(appState.currentWorkspace)
  const settings = getResolvedSettings(appState.currentWorkspace)
  configureLanguageServers(settings, appState.currentWorkspace)
  void syncMcpRuntime(settings, appState.currentWorkspace).catch(() => undefined)
  try {
    ensureCodeIndex(appState.currentWorkspace)
  } catch {
    // optional
  }
}

export const completeControllers = new Map<string, AbortController>()
export const abortAllCompletes = () => {
  for (const [id, ac] of completeControllers) {
    ac.abort()
    completeControllers.delete(id)
  }
}
