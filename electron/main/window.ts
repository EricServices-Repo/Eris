import { app, BrowserWindow, Menu, MenuItem, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { appState } from './app-state'

const isDev = !app.isPackaged

export function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', 'icons', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icons', 'icon.png'),
    join(__dirname, '../../resources/icons/icon.png'),
    join(process.cwd(), 'resources', 'icons', 'icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function rendererEntryUrl(): string {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  return join(__dirname, '../renderer/index.html')
}

function isAppRendererUrl(url: string): boolean {
  if (!url) return false
  if (url === 'about:blank') return true
  if (isDev) {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev && (url === dev || url.startsWith(dev + '/') || url.startsWith(dev + '?'))) return true
  }
  // Packaged: only the renderer shell HTML (not assets like .png / .js)
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    const path = decodeURIComponent(parsed.pathname)
    return /\/out\/renderer\/index\.html$/i.test(path) || /\/renderer\/index\.html$/i.test(path)
  } catch {
    return false
  }
}

function enableSystemSpellcheck(win: BrowserWindow): void {
  try {
    const available = win.webContents.session.availableSpellCheckerLanguages
    const preferred = app.getLocale()
    const match =
      available.find((lang) => lang.toLowerCase() === preferred.toLowerCase()) ||
      available.find((lang) => lang.toLowerCase().startsWith(preferred.slice(0, 2).toLowerCase()))
    if (match) win.webContents.session.setSpellCheckerLanguages([match])
  } catch {
    // macOS still uses the system spellchecker when the language list cannot be set.
  }
}

/** Right-click spelling corrections for the chat composer and agent replies. */
function attachSpellContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    if (!isChatSpellField(params) || win.isDestroyed()) return
    const x = Number(params.x)
    const y = Number(params.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    void win.webContents
      .executeJavaScript(
        `(() => {
          const el = document.elementFromPoint(${x}, ${y})
          return !!(el && el.closest && el.closest('.agent-composer textarea, .question-reply-input'))
        })()`,
        true
      )
      .then((inChat) => {
        if (inChat !== true || win.isDestroyed()) return
        showSpellMenu(win, params)
      })
      .catch(() => {})
  })
}

function isChatSpellField(params: Electron.ContextMenuParams): boolean {
  return (
    params.spellcheckEnabled &&
    params.misspelledWord.length > 0 &&
    (params.formControlType === 'text-area' || params.formControlType === 'input-text')
  )
}

function showSpellMenu(win: BrowserWindow, params: Electron.ContextMenuParams): void {
  const menu = new Menu()
  for (const suggestion of params.dictionarySuggestions) {
    menu.append(
      new MenuItem({
        label: suggestion,
        click: () => {
          if (!win.isDestroyed()) win.webContents.replaceMisspelling(suggestion)
        }
      })
    )
  }
  if (params.dictionarySuggestions.length) menu.append(new MenuItem({ type: 'separator' }))
  menu.append(
    new MenuItem({
      label: 'Add to dictionary',
      click: () => {
        if (!win.isDestroyed()) {
          win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        }
      }
    })
  )
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }))
  menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }))
  menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }))
  menu.append(new MenuItem({ role: 'selectAll', enabled: params.editFlags.canSelectAll }))
  menu.popup({ window: win })
}

function loadRenderer(win: BrowserWindow): void {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(rendererEntryUrl())
  }
}

export function createWindow(): void {
  const icon = resolveAppIcon()
  appState.mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1a1b1e',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  appState.mainWindow.on('ready-to-show', () => {
    appState.mainWindow?.show()
  })

  appState.mainWindow.webContents.setWindowOpenHandler((details) => {
    // Keep the shell intact — never open assets/binaries in-app
    if (/^https?:/i.test(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // Drag/drop or mistaken navigation to e.g. logo.png shows raw binary as "garbage"
  const rejectOffAppNavigation = (event: { preventDefault: () => void }, url: string) => {
    if (isAppRendererUrl(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  }
  appState.mainWindow.webContents.on('will-navigate', rejectOffAppNavigation)
  appState.mainWindow.webContents.on('will-redirect', rejectOffAppNavigation)

  appState.mainWindow.webContents.on('did-navigate', (_event, url) => {
    if (isAppRendererUrl(url) || !appState.mainWindow || appState.mainWindow.isDestroyed()) return
    loadRenderer(appState.mainWindow)
  })

  enableSystemSpellcheck(appState.mainWindow)
  attachSpellContextMenu(appState.mainWindow)
  loadRenderer(appState.mainWindow)
}
