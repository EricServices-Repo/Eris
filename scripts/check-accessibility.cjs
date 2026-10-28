const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'eris-keyboard-check-'))
app.setPath('userData', profile)
app.setPath('appData', profile)
app.commandLine.appendSwitch('password-store', 'basic')
app.commandLine.appendSwitch('use-mock-keychain')
const timeout = setTimeout(() => {
  console.error('Keyboard acceptance checks timed out')
  app.exit(1)
}, 30_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    width: 1000,
    height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  try {
    window.focus()
    await window.loadFile(resolve('.eris/cache/client-check/accessibility.html'))
    app.focus({ steal: true })
    window.focus()
    window.webContents.focus()
    const result = await window.webContents.executeJavaScript('window.accessibilityCheck()')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const focused = await window.webContents.executeJavaScript('document.hasFocus()')
    const active = await window.webContents.executeJavaScript(
      'document.activeElement !== document.body && document.activeElement !== document.querySelector("[data-chat-composer]")'
    )
    if (focused && !active) throw new Error('Real keyboard Tab lost focus')
    console.log(
      'Keyboard acceptance checks passed:',
      JSON.stringify({
        ...result,
        realTabFocus: focused ? active : 'unavailable-without-native-window-focus'
      })
    )
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
