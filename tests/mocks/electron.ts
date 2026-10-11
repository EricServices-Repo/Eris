import { tmpdir } from 'os'
import { join } from 'path'

const appData = () => process.env.ERIS_TEST_APPDATA || join(tmpdir(), 'eris-test-appdata')

export const app = {
  isPackaged: false,
  getPath: (name: string) => (name === 'exe' ? process.execPath : appData()),
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  getName: () => 'Eris'
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString()
}

export const ipcMain = { handle: () => undefined, on: () => undefined }
export const dialog = { showMessageBox: async () => ({ response: 0 }) }
export const shell = { openExternal: async () => undefined }
export const utilityProcess = { fork: () => ({ on: () => undefined, postMessage: () => undefined }) }
export class BrowserWindow {}
export type WebContents = { send: (...args: unknown[]) => void; isDestroyed: () => boolean }

export default { app, safeStorage, ipcMain, dialog, shell, utilityProcess, BrowserWindow }
