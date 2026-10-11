import { app, BrowserWindow, shell } from 'electron'
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
      nodeIntegration: false
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

  loadRenderer(appState.mainWindow)
}
