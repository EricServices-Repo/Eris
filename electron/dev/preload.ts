import { contextBridge, ipcRenderer } from 'electron'
import type { DevApi, DevProgress } from '../../src/shared/eris-dev'
const api: DevApi = {
  quality: (input) => ipcRenderer.invoke('dev:quality', input),
  qualityOpen: () => ipcRenderer.invoke('dev:qualityOpen'),
  qualityExport: () => ipcRenderer.invoke('dev:qualityExport'),
  qualityReview: () => ipcRenderer.invoke('dev:qualityReview'),
  models: () => ipcRenderer.invoke('dev:models'),
  connect: (input) => ipcRenderer.invoke('dev:connect', input),
  importQuestions: () => ipcRenderer.invoke('dev:import'),
  chooseProject: () => ipcRenderer.invoke('dev:project'),
  setProjectKind: (kind) => ipcRenderer.invoke('dev:project-kind', kind),
  start: (input) => ipcRenderer.invoke('dev:start', input),
  stop: () => ipcRenderer.invoke('dev:stop'),
  result: (index) => ipcRenderer.invoke('dev:result', index),
  exportRun: (options) => ipcRenderer.invoke('dev:export', options),
  listRuns: () => ipcRenderer.invoke('dev:runs'),
  resumeRun: (runId) => ipcRenderer.invoke('dev:resume', runId),
  openRun: (runId) => ipcRenderer.invoke('dev:open', runId),
  compareWith: () => ipcRenderer.invoke('dev:compare'),
  comparePage: (offset) => ipcRenderer.invoke('dev:compare-page', offset),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DevProgress) => listener(progress)
    ipcRenderer.on('dev:progress', handler)
    return () => ipcRenderer.removeListener('dev:progress', handler)
  }
}
contextBridge.exposeInMainWorld('erisDev', api)
