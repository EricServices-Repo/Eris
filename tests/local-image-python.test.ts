import { spawnSync } from 'child_process'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const candidates =
  process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python3.12', 'python3.11']
const python = candidates.find(
  (command) =>
    spawnSync(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)'])
      .status === 0
)

describe('real Python image worker contract (simulated ML dependencies)', () => {
  it.skipIf(!python)(
    'verifies download selection, integrity, offline loading, and native image dimensions',
    () => {
      const result = spawnSync(
        python!,
        ['-I', join(process.cwd(), 'tests/fixtures/local-image-worker-checks.py')],
        { encoding: 'utf8', timeout: 15_000 }
      )
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stderr).toContain('Ran 4 tests')
      expect(result.stderr).toContain('OK')
    }
  )
})
