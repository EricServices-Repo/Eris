const { spawn } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
if (!process.argv[2]) throw new Error('Pass the packaged Eris executable path')
const root = mkdtempSync(join(tmpdir(), 'eris-packaged-smoke-')),
  output = join(root, 'result.json')
const executable =
  process.argv[2] === '--auto'
    ? process.platform === 'win32'
      ? 'dist/win-unpacked/Eris.exe'
      : readdirSync('dist')
          .map((name) => `dist/${name}/Eris.app/Contents/MacOS/Eris`)
          .find((path) => existsSync(path))
    : process.argv[2]
if (!executable) throw new Error('No packaged Eris executable found')
const child = spawn(resolve(executable), ['--eris-smoke-test'], {
  stdio: 'pipe',
  env: { ...process.env, ERIS_SMOKE_ROOT: root, ERIS_SMOKE_OUTPUT: output }
})
let logs = ''
child.stderr.on('data', (data) => {
  logs = (logs + data).slice(-4000)
})
const timeout = setTimeout(() => {
  child.kill()
  console.error('Packaged app smoke timed out')
  process.exitCode = 1
}, 60000)
child.once('error', (error) => {
  clearTimeout(timeout)
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', (code) => {
  clearTimeout(timeout)
  try {
    const report = JSON.parse(readFileSync(output, 'utf8'))
    if (code !== 0 || !report.ok || !report.packaged)
      throw new Error(report.error || 'App failed smoke checks')
    console.log(JSON.stringify(report))
    if (process.env.ERIS_SMOKE_REPORT)
      require('node:fs').copyFileSync(output, process.env.ERIS_SMOKE_REPORT)
  } catch (error) {
    console.error(error.message, logs)
    process.exitCode = 1
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
