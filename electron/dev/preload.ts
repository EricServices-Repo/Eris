import { contextBridge, ipcRenderer } from 'electron'
import type { DevApi, DevProgress } from '../../src/shared/eris-dev'
const api: DevApi = {
  importQuestions: () => ipcRenderer.invoke('dev:import'),
  chooseProject: () => ipcRenderer.invoke('dev:project'),
  setProjectKind: (kind) => ipcRenderer.invoke('dev:project-kind', kind),
  start: (input) => ipcRenderer.invoke('dev:start', input),
  stop: () => ipcRenderer.invoke('dev:stop'),
  result: (index) => ipcRenderer.invoke('dev:result', index),
  exportRun: () => ipcRenderer.invoke('dev:export'),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DevProgress) => listener(progress)
    ipcRenderer.on('dev:progress', handler)
    return () => ipcRenderer.removeListener('dev:progress', handler)
  }
}
contextBridge.exposeInMainWorld('erisDev', api)
