/** Parent owns temporary probe data; Electron must exit before Windows releases its files. */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const root = mkdtempSync(join(tmpdir(), 'eris-process-probe-'))
let result
try {
  result = spawnSync(require('electron'), [join(__dirname, 'check-native-recovery.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, ERIS_PROBE_ROOT: root },
    timeout: 45000
  })
  if (result.error) console.error(result.error.message)
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
process.exitCode = result?.status === 0 ? 0 : 1
