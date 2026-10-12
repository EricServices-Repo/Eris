import { Menu, shell } from 'electron'
import { checkForUpdatesNow } from './services/auto-update'
import { appState } from './app-state'

export function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Eris',
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdatesNow()
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => appState.mainWindow?.webContents.send('menu:settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => appState.mainWindow?.webContents.send('menu:new-workspace')
        },
        {
          label: 'Link Folder as Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => appState.mainWindow?.webContents.send('menu:open-folder')
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => appState.mainWindow?.webContents.send('menu:save')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => appState.mainWindow?.webContents.send('menu:command-palette')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Agent',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+L',
          click: () => appState.mainWindow?.webContents.send('menu:new-chat')
        },
        {
          label: 'Stop Generation',
          click: () => {
            appState.chatAbort?.abort()
            appState.mainWindow?.webContents.send('menu:stop-chat')
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Report a Bug…',
          click: () => appState.mainWindow?.webContents.send('menu:report-bug')
        },
        {
          label: 'Eris Feedback on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/EricServices-Repo/Eris-feedback/issues')
          }
        }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
