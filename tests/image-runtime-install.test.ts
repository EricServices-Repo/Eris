import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import {
  activeImageRuntime,
  publishImageRuntime,
  imageFailure,
  readImageSetupState,
  publishImageModel
} from '../electron/main/services/image-runtime-install'
const roots: string[] = []
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'eris-image-install-'))
  roots.push(path)
  return path
}
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const build = async (python: string) => {
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, 'verified fixture')
  return {
    ready: { ready: true, device: 'cpu', deviceName: 'Fixture CPU' },
    provenance: { python: '3.12', packages: { torch: '2.8.0' } }
  }
}
describe('image environment publication', () => {
  it('retains a working environment while failed repair stages are discarded', async () => {
    const path = root(),
      first = await publishImageRuntime(path, 'cpu', build),
      active = activeImageRuntime(path)
    await expect(
      publishImageRuntime(path, 'cpu', async (python) => {
        await build(python)
        throw new Error('No matching distribution for wheel')
      })
    ).rejects.toThrow(/Python 3.10/)
    expect(activeImageRuntime(path).pointer?.environmentId).toBe(first.environmentId)
    expect(readFileSync(active.python, 'utf8')).toBe('verified fixture')
    expect(readImageSetupState(path)?.code).toBe('dependencies')
  })
  it('does not activate cancelled or mismatched CUDA setup and preserves the original pointer', async () => {
    const path = root(),
      first = await publishImageRuntime(path, 'cpu', build),
      controller = new AbortController()
    await expect(
      publishImageRuntime(
        path,
        'cpu',
        async (python) => {
          const result = await build(python)
          controller.abort()
          return result
        },
        controller.signal
      )
    ).rejects.toThrow(/stopped/i)
    expect(activeImageRuntime(path).pointer?.environmentId).toBe(first.environmentId)
    await expect(publishImageRuntime(path, 'cuda', build)).rejects.toThrow(/driver/)
    expect(activeImageRuntime(path).pointer?.environmentId).toBe(first.environmentId)
  })
  it('keeps stable venv paths when activating a verified replacement', async () => {
    const path = root(),
      first = await publishImageRuntime(path, 'cpu', build),
      old = activeImageRuntime(path).python,
      second = await publishImageRuntime(path, 'cpu', build)
    expect(first.environmentId).not.toBe(second.environmentId)
    expect(existsSync(old)).toBe(true)
    expect(activeImageRuntime(path).python).toContain(second.environmentId)
    expect(activeImageRuntime(path).pointer?.provenance.packages).toEqual({ torch: '2.8.0' })
  })
  it('retains legacy environments and partial downloads outside active model publication', async () => {
    const path = root(),
      legacy = activeImageRuntime(path).python
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, 'legacy')
    expect(activeImageRuntime(path).python).toBe(legacy)
    const partial = join(path, '.partial', 'model'),
      destination = join(path, 'model')
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(partial, 'weights'), 'partial')
    expect(existsSync(destination)).toBe(false)
    await publishImageModel(partial, destination, { revision: 'a'.repeat(40) })
    expect(readFileSync(join(destination, 'weights'), 'utf8')).toBe('partial')
    expect(existsSync(join(destination, 'ready.json'))).toBe(true)
  })
  it('provides distinct auth, disk, driver and dependency guidance without echoing tokens', () => {
    for (const [error, code] of [
      ['401 gated hf_secret', 'auth'],
      ['ENOSPC disk full', 'disk'],
      ['CUDA incompatible driver', 'driver'],
      ['No matching distribution wheel', 'dependencies'],
      ['cancelled', 'cancelled']
    ]) {
      const failure = imageFailure(new Error(error))
      expect(failure.code).toBe(code)
      expect(failure.message).not.toContain('hf_secret')
    }
  })
})
