import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore, type CredentialVault } from '../electron/main/services/credential-store'
import { ForegroundTasks } from '../electron/main/services/foreground-tasks'
import {
  parseChatSubmission,
  submissionDigest,
  validateSubmissionPaths
} from '../electron/main/services/chat-submission'
const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'eris-runtime-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const vault: CredentialVault = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString()
}

describe('explicit credential policy', () => {
  it('preserves legacy values and only encrypts after user selection', () => {
    const root = fixture()
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ synthetic: 'test-value' }))
    let calls = 0
    const store = new CredentialStore(() => root, {
      ...vault,
      available: () => {
        calls++
        return true
      }
    })
    expect(store.get('synthetic')).toBe('test-value')
    expect(calls).toBe(0)
    store.set('second', 'second-value')
    expect(calls).toBe(0)
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
    store.select('vault')
    expect(store.get('second')).toBe('second-value')
    expect(readFileSync(join(root, 'credentials.json'), 'utf8')).not.toContain('second-value')
    store.set('synthetic', '')
    expect(store.get('synthetic')).toBeNull()
    store.select('local')
    expect(store.get('second')).toBe('second-value')
  })
  it('fails without replacing unreadable legacy data or an unavailable vault', () => {
    const root = fixture()
    writeFileSync(join(root, 'secrets.bin'), 'unreadable-legacy')
    const store = new CredentialStore(() => root, { ...vault, available: () => false })
    expect(() => store.set('key', 'value')).toThrow('preserved')
    expect(readFileSync(join(root, 'secrets.bin'), 'utf8')).toBe('unreadable-legacy')
    rmSync(join(root, 'secrets.bin'))
    store.set('key', 'value')
    const original = readFileSync(join(root, 'credentials.json'), 'utf8')
    expect(() => store.select('vault')).toThrow('unavailable')
    expect(readFileSync(join(root, 'credentials.json'), 'utf8')).toBe(original)
  })
  it('decrypts legacy ciphertext only on explicit vault selection', () => {
    const root = fixture()
    writeFileSync(join(root, 'secrets.bin'), vault.encrypt(JSON.stringify({ test: 'synthetic' })))
    const store = new CredentialStore(() => root, vault)
    expect(() => store.get('test')).toThrow('preserved')
    store.select('vault')
    expect(store.get('test')).toBe('synthetic')
  })
})

describe('migration keeps every legacy store', () => {
  it('does not discard a second encrypted legacy file when plaintext credentials are readable', () => {
    const root = fixture()
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ plain: 'synthetic-plain' }))
    writeFileSync(
      join(root, 'secrets.bin'),
      vault.encrypt(JSON.stringify({ encrypted: 'synthetic-encrypted' }))
    )
    const store = new CredentialStore(() => root, vault)
    expect(store.get('plain')).toBe('synthetic-plain')
    expect(() => store.set('new', 'value')).toThrow('preserved')
    expect(existsSync(join(root, 'secrets.bin'))).toBe(true)
    store.select('vault')
    expect(store.get('plain')).toBe('synthetic-plain')
    expect(store.get('encrypted')).toBe('synthetic-encrypted')
    expect(existsSync(join(root, 'secrets.bin'))).toBe(false)
  })
})

describe('submission and queue boundaries', () => {
  const request = {
    requestId: 'one',
    model: 'test',
    messages: [{ role: 'user', content: 'hello' }]
  }
  it('rejects unknown fields, nonfinite timing, excessive payloads and stale workspaces', () => {
    expect(() => parseChatSubmission({ ...request, unknown: true })).toThrow()
    expect(() => parseChatSubmission({ ...request, planningDurationMs: Infinity })).toThrow()
    expect(() => parseChatSubmission({ ...request, turnPlan: 'x'.repeat(2_000_000) })).toThrow(
      '2 MB'
    )
    expect(() =>
      validateSubmissionPaths(
        parseChatSubmission({ ...request, workspacePath: '/previous' }),
        '/current'
      )
    ).toThrow('changed')
  })
  it('canonicalizes admission digest without letting legacy plans alter authority', () => {
    const first = parseChatSubmission(request)
    const second = parseChatSubmission({
      messages: request.messages,
      model: 'test',
      requestId: 'one',
      turnPlan: { edit: true }
    })
    expect(submissionDigest(first, null)).toBe(submissionDigest(second, null))
    expect(submissionDigest(first, null)).not.toBe(
      submissionDigest(parseChatSubmission({ ...request, model: 'other' }), null)
    )
  })
  it('queues without aborting the active task and enforces stop ownership', async () => {
    const queue = new ForegroundTasks(),
      owner = {},
      other = {}
    let release!: () => void
    let signal!: AbortSignal
    let secondRan = false
    const active = queue.run('first', owner, async (controller) => {
      signal = controller.signal
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'done'
    })
    await Promise.resolve()
    const pending = queue.run('second', other, async () => {
      secondRan = true
    })
    expect(queue.stop('second', owner)).toBe(false)
    expect(queue.stop('second', other)).toBe(true)
    expect(signal.aborted).toBe(false)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await expect(active).resolves.toBe('done')
    await rejection
    expect(secondRan).toBe(false)
    expect(queue.size).toBe(0)
  })
})

describe('application shutdown admission', () => {
  it('aborts owned controllers and prevents queued or newly submitted work from starting', async () => {
    const queue = new ForegroundTasks(),
      owner = {}
    let release!: () => void
    let signal!: AbortSignal
    let ran = false
    const active = queue.run('active', owner, async (controller) => {
      signal = controller.signal
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await Promise.resolve()
    const queued = queue.run('queued', owner, async () => {
      ran = true
    })
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    queue.close()
    expect(signal.aborted).toBe(true)
    await expect(queue.run('new', owner, async () => undefined)).rejects.toThrow('closing')
    release()
    await active
    await rejected
    expect(ran).toBe(false)
  })
})

describe('immutable release source', () => {
  const { resolveSource } = createRequire(import.meta.url)('../scripts/release-source.cjs') as {
    resolveSource: (tag: string, git: (...args: string[]) => string) => Record<string, string>
  }
  const sha = 'a'.repeat(40)
  const git = (...args: string[]) =>
    args[0] === 'rev-parse'
      ? sha
      : args[0] === 'merge-base'
        ? ''
        : args[1]!.endsWith(':package.json')
          ? JSON.stringify({ version: '1.2.3' })
          : JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } })
  it('pins all jobs to the tag SHA and validates committed versions', () => {
    expect(resolveSource('1.2.3', git)).toMatchObject({
      tag: 'v1.2.3',
      build_ref: sha,
      source_sha: sha,
      tag_sha: sha
    })
    expect(() => resolveSource('1.2.4', git)).toThrow('versions must match')
    expect(() => resolveSource('main;echo unsafe', git)).toThrow('Invalid release tag')
    expect(() =>
      resolveSource('1.2.3', (...args) => {
        if (args[0] === 'merge-base') throw new Error('not integrated')
        return git(...args)
      })
    ).toThrow('not integrated')
  })
})
