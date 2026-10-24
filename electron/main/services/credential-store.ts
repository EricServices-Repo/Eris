import { safeStorage } from 'electron'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { userDataRoot } from './paths'
export type CredentialPolicy = 'local' | 'vault'
export interface CredentialVault {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
export const electronVault: CredentialVault = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    (!('getSelectedStorageBackend' in safeStorage) ||
      safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value)
}
function parsePrivateJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      'Credential data could not be read. The original file has been preserved; restore it before making changes.'
    )
  }
}
function values(input: unknown): Record<string, string> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.values(input).some((value) => typeof value !== 'string')
  )
    throw new Error('Credential data is invalid; restore it before making changes.')
  return input as Record<string, string>
}
/** Opt-in encryption. Local reads do not invoke the OS vault or discard legacy ciphertext. */
export class CredentialStore {
  constructor(
    private root: () => string,
    private vault: CredentialVault
  ) {}
  status(): { policy: CredentialPolicy; legacyPending: boolean; plaintextRemaining: boolean } {
    const path = join(this.root(), 'credentials.json')
    const policy = existsSync(path)
      ? (parsePrivateJson(readFileSync(path, 'utf8')) as { policy?: unknown }).policy
      : 'local'
    if (policy !== 'local' && policy !== 'vault')
      throw new Error('Unknown credential storage policy')
    return {
      policy,
      legacyPending: existsSync(join(this.root(), 'secrets.bin')),
      plaintextRemaining: policy === 'vault' && existsSync(join(this.root(), 'secrets.json'))
    }
  }
  readAll(): Record<string, string> {
    const path = join(this.root(), 'credentials.json')
    if (existsSync(path)) {
      const record = parsePrivateJson(readFileSync(path, 'utf8')) as {
        version?: number
        policy?: string
        values?: unknown
        encrypted: string
      }
      if (record.version !== 1) throw new Error('Unsupported credential store version')
      if (record.policy === 'local') return { ...values(record.values) }
      if (record.policy !== 'vault' || !this.vault.available())
        throw new Error(
          'The selected OS credential vault is unavailable. Unlock it to access credentials.'
        )
      return {
        ...values(parsePrivateJson(this.vault.decrypt(Buffer.from(record.encrypted, 'base64'))))
      }
    }
    for (const name of ['secrets.json', 'secrets.bin']) {
      const legacy = join(this.root(), name)
      if (existsSync(legacy)) {
        try {
          return { ...values(JSON.parse(readFileSync(legacy, 'utf8'))) }
        } catch {
          throw new Error(
            'Legacy credentials could not be read. The original file has been preserved; restore or migrate it explicitly.'
          )
        }
      }
    }
    return {}
  }
  get(key: string): string | null {
    const stored = this.readAll()
    return Object.hasOwn(stored, key) ? stored[key] || null : null
  }
  set(key: string, value: string): void {
    if (!key || key.length > 256 || value.length > 64000)
      throw new Error('Invalid credential key or value')
    const next = this.mutationValues(this.status().policy === 'vault')
    if (value)
      Object.defineProperty(next, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    else delete next[key]
    this.write(next, this.status().policy)
  }
  private mutationValues(allowVault: boolean): Record<string, string> {
    const maps: Record<string, string>[] = []
    if (existsSync(join(this.root(), 'credentials.json'))) maps.push(this.readAll())
    for (const name of ['secrets.json', 'secrets.bin']) {
      const path = join(this.root(), name)
      if (!existsSync(path)) continue
      const raw = readFileSync(path)
      try {
        maps.push(values(parsePrivateJson(raw.toString('utf8'))))
      } catch {
        if (name !== 'secrets.bin' || !allowVault || !this.vault.available())
          throw new Error(
            'Legacy credentials could not be read. The original file has been preserved; select the OS vault to migrate encrypted data or restore the file.'
          )
        maps.push(values(parsePrivateJson(this.vault.decrypt(raw))))
      }
    }
    const merged: Record<string, string> = {}
    for (const map of maps)
      for (const [key, value] of Object.entries(map)) {
        if (Object.hasOwn(merged, key) && merged[key] !== value)
          throw new Error(
            'Credential stores disagree. Original files have been preserved; reconcile them before migrating.'
          )
        Object.defineProperty(merged, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true
        })
      }
    return merged
  }
  select(policy: CredentialPolicy): void {
    if (!['local', 'vault'].includes(policy)) throw new Error('Unknown credential policy')
    this.write(this.mutationValues(policy === 'vault'), policy)
  }
  private write(next: Record<string, string>, policy: CredentialPolicy): void {
    if (policy === 'vault' && !this.vault.available())
      throw new Error(
        'OS credential encryption is unavailable; the storage policy was not changed.'
      )
    const record =
      policy === 'vault'
        ? {
            version: 1,
            policy,
            encrypted: this.vault.encrypt(JSON.stringify(next)).toString('base64')
          }
        : { version: 1, policy, values: next }
    mkdirSync(this.root(), { recursive: true, mode: 0o700 })
    const target = join(this.root(), 'credentials.json'),
      tmp = target + `.${randomUUID()}.tmp`
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      chmodSync(tmp, 0o600)
      if (process.platform === 'win32') {
        const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
          encoding: 'utf8',
          windowsHide: true
        })
        const sid = identity.match(/S-1-[0-9-]+/)?.[0]
        if (!sid)
          throw new Error(
            'Cannot identify the Windows account; credential update was not committed.'
          )
        execFileSync('icacls', [tmp, '/inheritance:r', '/grant:r', `*${sid}:(F)`], {
          stdio: 'pipe',
          windowsHide: true
        })
      }
      writeFileSync(fd, JSON.stringify(record), 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
    for (const name of ['secrets.json', 'secrets.bin']) {
      const legacy = join(this.root(), name)
      if (existsSync(legacy)) unlinkSync(legacy) // After the new store is durable; failure is reported, never hidden.
    }
  }
}
export const credentialStore = new CredentialStore(userDataRoot, electronVault)
