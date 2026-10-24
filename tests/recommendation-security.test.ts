import { createRequire } from 'module'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { confinedPath, readBoundedText } from '../cloud-agent/src/workspace-paths'
const { scan } = createRequire(import.meta.url)('../scripts/check-packaged-secrets.cjs') as {
  scan: (root: string) => void
}
const roots: string[] = []
const fixture = () => {
  const path = mkdtempSync(join(tmpdir(), 'eris-security-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged credential boundary', () => {
  it('rejects a credential file without disclosing its content', () => {
    const root = fixture()
    writeFileSync(join(root, 'eris-feedback-token'), 'synthetic-private-value')
    expect(() => scan(root)).toThrow('Packaged shared feedback credential')
  })
  it('rejects token-shaped data across scan chunk boundaries inside an ASAR payload', () => {
    const root = fixture()
    const secret = 'ghp_' + 'a'.repeat(36)
    writeFileSync(join(root, 'app.asar'), 'x'.repeat(65530) + secret)
    try {
      scan(root)
      throw new Error('Expected rejection')
    } catch (error) {
      expect(String(error)).toContain('Credential-shaped')
      expect(String(error)).not.toContain(secret)
    }
  })
})

describe('cloud file confinement', () => {
  it('rejects absolute, drive, traversal and NUL paths but permits ordinary dot names', () => {
    const root = fixture()
    for (const path of ['/etc/passwd', 'C:\\config', '../escape', 'a/../../escape', 'a\0b'])
      expect(() => confinedPath(root, path)).toThrow()
    expect(confinedPath(root, 'file..txt')).toBe(join(realpathSync(root), 'file..txt'))
  })
  it('rejects external and dangling symlink parents before a read or write', () => {
    const root = fixture(),
      outside = fixture()
    mkdirSync(join(root, 'nested'))
    symlinkSync(
      outside,
      join(root, 'nested', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(() => confinedPath(root, 'nested/link/new.txt')).toThrow('symbolic links')
    if (process.platform !== 'win32') {
      symlinkSync(join(outside, 'missing'), join(root, 'dangling'))
      expect(() => confinedPath(root, 'dangling/file')).toThrow('symbolic links')
    }
  })
  it('bounds reads before allocation and marks truncated output', () => {
    const root = fixture(),
      path = join(root, 'large.txt')
    writeFileSync(path, 'a'.repeat(100000))
    expect(readBoundedText(path, 1024)).toBe('a'.repeat(1024) + '\n\n[truncated]')
  })
})

describe('cloud command admission', () => {
  it('plans an empty environment, network isolation, bounded temporary storage and read-only verification', async () => {
    const { sandboxPlan } = await import('../cloud-agent/src/job-sandbox')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const root = fixture()
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const plan = sandboxPlan(root, 'npm test', true)
      expect(plan.args).toContain('--unshare-all')
      expect(plan.args).toContain('--clearenv')
      expect(plan.args).toContain('--fsize=67108864')
      expect(plan.args).toContain('67108864')
      expect(
        plan.args.slice(
          plan.args.indexOf(realpathSync(root)) - 1,
          plan.args.indexOf(realpathSync(root)) + 2
        )
      ).toEqual(['--ro-bind', realpathSync(root), '/workspace'])
      expect(Object.keys(plan.env).sort()).toEqual(['LANG', 'PATH'])
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
  it('never launches a command without a delegated resource boundary', async () => {
    const { runIsolatedCommand } = await import('../cloud-agent/src/job-sandbox')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const configured = process.env.ERIS_CLOUD_CGROUP_ROOT
    let result: Promise<{ ok: boolean; detail: string }>
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      delete process.env.ERIS_CLOUD_CGROUP_ROOT
      result = runIsolatedCommand(fixture(), 'printf unsafe')
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
      if (configured) process.env.ERIS_CLOUD_CGROUP_ROOT = configured
    }
    expect(await result!).toMatchObject({
      ok: false,
      detail: expect.stringContaining('delegated cgroup')
    })
  })
})
