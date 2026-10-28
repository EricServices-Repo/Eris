const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'eris-capabilities-check-'))
app.setPath('userData', profile)
app.setPath('appData', profile)
app.commandLine.appendSwitch('password-store', 'basic')
app.commandLine.appendSwitch('use-mock-keychain')
const timeout = setTimeout(() => {
  console.error('Language edit checks timed out')
  app.exit(1)
}, 30_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  try {
    await window.loadFile(resolve('.eris/cache/client-check/capabilities.html'))
    const result = await window.webContents.executeJavaScript('window.capabilitiesCheck()')
    console.log('Language edit checks passed:', JSON.stringify(result))
    window.destroy()
    clearTimeout(timeout)
    rmSync(profile, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    window.destroy()
    rmSync(profile, { recursive: true, force: true })
    app.exit(1)
  }
})
