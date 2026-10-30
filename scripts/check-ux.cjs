const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'eris-ux-check-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('password-store', 'basic')
app.commandLine.appendSwitch('use-mock-keychain')
const timeout = setTimeout(() => {
  console.error('UX acceptance checks timed out')
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
    await window.loadFile(resolve('.eris/cache/client-check/ux.html'))
    const result = await window.webContents.executeJavaScript('window.uxCheck()')
    console.log('UX acceptance checks passed:', JSON.stringify(result))
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
