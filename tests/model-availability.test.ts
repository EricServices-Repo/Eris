import { describe, expect, it, vi } from 'vitest'
import { detectLocalModelService } from '../electron/main/services/model-setup'

describe('first-run model discovery', () => {
  it.each([
    ['ollama', '11434'],
    ['lmstudio', '1234']
  ] as const)('detects %s on its loopback port', async (id, port) => {
    const probe = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ id: 'qwen' }, { id: 'qwen' }, { id: 42 }, null]
    }))
    await expect(detectLocalModelService(id, probe)).resolves.toMatchObject({ id, models: ['qwen'] })
    expect(probe).toHaveBeenCalledWith(
      `http://127.0.0.1:${port}/v1/models`,
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    )
  })

  it('distinguishes a running empty server from an invalid response or failed probe', async () => {
    const probe = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ data: null }))
      .mockRejectedValueOnce(new Error('offline'))
    await expect(detectLocalModelService('ollama', probe)).resolves.toMatchObject({ models: [] })
    await expect(detectLocalModelService('ollama', probe)).resolves.toBeNull()
    await expect(detectLocalModelService('ollama', probe)).resolves.toBeNull()
  })
})
