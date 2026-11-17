const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { version } = require('../package.json')

const output = resolve('dist-dev')
const appName = 'Eris-Dev.app'
const app = join(output, 'mac-arm64', appName)
const asset = join(output, `Eris-Dev-${version}-mac-arm64.zip`)
const staging = mkdtempSync(join(output, '.archive-'))
const smoke = mkdtempSync(join(tmpdir(), 'eris-dev-archive-'))

try {
  const zip = join(staging, 'Eris-Dev.zip')
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  if (!statSync(zip).size) throw new Error('Eris-Dev archive is empty')
  execFileSync('ditto', ['-x', '-k', zip, smoke])
  const bundle = join(smoke, appName)
  const executable = join(bundle, 'Contents', 'MacOS', 'Eris-Dev')
  const resources = join(bundle, 'Contents', 'Resources')
  const plist = (key) => execFileSync('/usr/libexec/PlistBuddy',
    ['-c', `Print ${key}`, join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
  if (plist('CFBundleIdentifier') !== 'app.eris.dev' || plist('CFBundleShortVersionString') !== version)
    throw new Error('Wrong Eris-Dev bundle identity or version')
  if (execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim() !== 'arm64')
    throw new Error('Eris-Dev archive must contain an arm64 app')
  if (existsSync(join(resources, 'app-update.yml')) || existsSync(join(resources, 'resources', 'app-update.yml')))
    throw new Error('Eris-Dev must not contain production updater metadata')
  if (process.env.CSC_LINK) execFileSync('codesign', ['--verify', '--deep', '--strict', bundle])
  const profile = join(smoke, 'profile')
  mkdirSync(profile)
  const smokeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CSC_|APPLE_|MAC_CERT_)/.test(key)))
  const log = execFileSync(executable, ['--eris-dev-smoke-test'], {
    env: { ...smokeEnv, ERIS_DEV_SMOKE_PROFILE: profile }, encoding: 'utf8', timeout: 60000
  })
  if (!log.includes('ERIS_DEV_PACKAGED_SMOKE_OK')) throw new Error('Eris-Dev did not report a successful smoke test')
  renameSync(zip, asset)
  console.log(`Verified ${asset}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
  rmSync(smoke, { recursive: true, force: true })
}
