import { expect, it, vi } from 'vitest'
import { readModelStatus } from '../electron/preload/model-status'

const stale = new Error(
  'Error invoking remote method models:status: {"code":"PRIVILEGED_REQUEST_REJECTED","message":"Stale workspace association"}'
)
it('refreshes the workspace envelope and retries a catalog read overtaken by workspace restore', async () => {
  const options = { probe: true }
  const status = { ok: true, models: [{ name: 'builtin:composer-lite', ready: true }] }
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(stale)
    .mockResolvedValueOnce('/workspace')
    .mockResolvedValueOnce(status)
  expect(await readModelStatus(invoke, options)).toBe(status)
  expect(invoke.mock.calls).toEqual([
    ['models:status', options],
    ['workspace:getCurrent'],
    ['models:status', options]
  ])
})
it('does not retry unrelated rejection or loop when the workspace keeps changing', async () => {
  const invoke = vi.fn().mockRejectedValue(new Error('Unauthorized window or frame'))
  await expect(readModelStatus(invoke, undefined)).rejects.toThrow('Unauthorized')
  expect(invoke).toHaveBeenCalledTimes(1)
  const moving = vi
    .fn()
    .mockRejectedValueOnce(stale)
    .mockResolvedValueOnce('/new')
    .mockRejectedValueOnce(stale)
  await expect(readModelStatus(moving, undefined)).rejects.toThrow('Stale workspace')
  expect(moving).toHaveBeenCalledTimes(3)
})
