import { safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { getResolvedSettings } from '../services/settings'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../services/workspace-watcher'
import { disposeMcpRuntime, syncMcpRuntime } from '../services/mcp-runtime'
import { ensureCodeIndex } from '../services/code-index'
import { disposePtySession } from '../services/pty-session'
import { disposeLanguageServers, configureLanguageServers } from '../services/language-servers'
import { userDataRoot } from '../services/paths'
import { appState } from '../app-state'

/** Plain JSON on disk — never Electron safeStorage / OS Keychain. */
const secretsPath = (): string => join(userDataRoot(), 'secrets.json')
/** Legacy path from when secrets were safeStorage-encrypted (Keychain on macOS). */
const legacySecretsPath = (): string => join(userDataRoot(), 'secrets.bin')

function parseSecretsPayload(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

function tryDecryptLegacy(buf: Buffer): Record<string, string> | null {
  // Migration only: older builds wrote safeStorage ciphertext (Keychain on macOS).
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return parseSecretsPayload(safeStorage.decryptString(buf))
  } catch {
    return null
  }
}

function readSecretsMap(): Record<string, string> {
  const jsonPath = secretsPath()
  if (existsSync(jsonPath)) {
    try {
      const map = parseSecretsPayload(readFileSync(jsonPath, 'utf8'))
      if (map) return map
    } catch {
      // fall through
    }
  }

  const binPath = legacySecretsPath()
  if (!existsSync(binPath)) return {}

  try {
    const buf = readFileSync(binPath)
    const asUtf8 = parseSecretsPayload(buf.toString('utf8'))
    if (asUtf8) {
      writeSecretsMap(asUtf8)
      return asUtf8
    }
    const migrated = tryDecryptLegacy(buf)
    if (migrated) {
      writeSecretsMap(migrated)
      return migrated
    }
  } catch {
    // ignore
  }
  return {}
}

function writeSecretsMap(map: Record<string, string>): void {
  mkdirSync(userDataRoot(), { recursive: true })
  const payload = JSON.stringify(map)
  const target = secretsPath()
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, payload, 'utf8')
  renameSync(tmp, target)
  const binPath = legacySecretsPath()
  if (existsSync(binPath)) {
    try {
      unlinkSync(binPath)
    } catch {
      // best-effort cleanup of Keychain-era file
    }
  }
}

export function storeSecret(key: string, value: string): void {
  const map = readSecretsMap()
  if (!value) {
    delete map[key]
  } else {
    map[key] = value
  }
  writeSecretsMap(map)
}

export function getSecret(key: string): string | null {
  const map = readSecretsMap()
  const value = map[key]
  return value && value.length > 0 ? value : null
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
