import type { BrowserWindow } from 'electron'

export const appState = {
  mainWindow: null as BrowserWindow | null,
  currentWorkspace: null as string | null,
  chatAbort: null as AbortController | null,
  /** True while a chat:stream invoke is in flight (not merely holding the last AbortController). */
  chatStreamActive: false,
  activeChatRequestId: null as string | null
}
