import type { BrowserWindow } from 'electron'

let currentWorkspace: string | null = null
let workspaceEpoch = 0
export const appState = {
  mainWindow: null as BrowserWindow | null,
  get currentWorkspace() {
    return currentWorkspace
  },
  set currentWorkspace(value: string | null) {
    if (value !== currentWorkspace) {
      currentWorkspace = value
      workspaceEpoch++
    }
  },
  get workspaceEpoch() {
    return workspaceEpoch
  },
  chatAbort: null as AbortController | null,
  /** True while a chat:stream invoke is in flight (not merely holding the last AbortController). */
  chatStreamActive: false,
  activeChatRequestId: null as string | null
}
