import { vi } from 'vitest'
// Default resource conditions are synthetic. Pressure tests inject their own
// samples; a busy developer machine must not disable unrelated recall fixtures.
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>()
  return { ...actual, totalmem: () => 32 * 1024 ** 3, freemem: () => 24 * 1024 ** 3 }
})
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.ERIS_TEST_APPDATA = mkdtempSync(join(tmpdir(), 'eris-test-'))
