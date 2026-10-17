import { join } from 'path'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { getResolvedSettings } from '../services/settings'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../services/workspace-watcher'
import { disposeMcpRuntime, syncMcpRuntime } from '../services/mcp-runtime'
import { ensureCodeIndex } from '../services/code-index'
import { disposePtySession } from '../services/pty-session'
import { disposeLanguageServers, configureLanguageServers } from '../services/language-servers'
import { userDataRoot } from '../services/paths'
import { appState } from '../app-state'

/** Plain JSON in userData — never Electron safeStorage / OS Keychain. */
const secretsPath = (): string => join(userDataRoot(), 'secrets.json')
/** Pre-Keychain-removal path; only plain JSON is migrated, ciphertext is discarded. */
const legacySecretsPath = (): string => join(userDataRoot(), 'secrets.bin')

/** In-memory cache so hot paths do not re-read secrets.json on every getSecret. */
let secretsCache: Record<string, string> | null = null

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

function discardLegacySecretsFile(): void {
  const binPath = legacySecretsPath()
  if (!existsSync(binPath)) return
  try {
    unlinkSync(binPath)
  } catch {
    // best-effort
  }
}

function readSecretsMap(): Record<string, string> {
  if (secretsCache) return { ...secretsCache }

  const jsonPath = secretsPath()
  if (existsSync(jsonPath)) {
    try {
      const map = parseSecretsPayload(readFileSync(jsonPath, 'utf8'))
      if (map) {
        try {
          chmodSync(jsonPath, 0o600)
        } catch {
          // Windows ACLs are inherited from the user data directory.
        }
        secretsCache = map
        return { ...map }
      }
    } catch {
      // fall through
    }
  }

  const binPath = legacySecretsPath()
  if (!existsSync(binPath)) {
    secretsCache = {}
    return {}
  }

  // Migrate only if the legacy file is already plain JSON. Never call safeStorage —
  // decrypting it on macOS prompts the OS Keychain.
  try {
    const asUtf8 = parseSecretsPayload(readFileSync(binPath, 'utf8'))
    if (asUtf8) {
      writeSecretsMap(asUtf8)
      return { ...asUtf8 }
    }
  } catch {
    // ignore
  }
  discardLegacySecretsFile()
  secretsCache = {}
  return {}
}

function writeSecretsMap(map: Record<string, string>): void {
  secretsCache = { ...map }
  mkdirSync(userDataRoot(), { recursive: true })
  const payload = JSON.stringify(map)
  const target = secretsPath()
  const tmp = `${target}.${process.pid}.tmp`
  // The app deliberately avoids OS credential stores to prevent surprise
  // Keychain prompts. Keep the local fallback private to the current account.
  writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows ACLs are inherited from the user data directory.
  }
  renameSync(tmp, target)
  try {
    chmodSync(target, 0o600)
  } catch {
    // Windows ACLs are inherited from the user data directory.
  }
  discardLegacySecretsFile()
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
  // Index off the interactive path — open workspace should not wait on it.
  setImmediate(() => {
    try {
      if (appState.currentWorkspace) ensureCodeIndex(appState.currentWorkspace)
    } catch {
      // optional
    }
  })
}

export const completeControllers = new Map<string, AbortController>()
export const abortAllCompletes = () => {
  for (const [id, ac] of completeControllers) {
    ac.abort()
    completeControllers.delete(id)
  }
}
