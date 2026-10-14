import { ipcMain } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import { appState } from '../app-state'
import { logInfo, logWarn } from '../services/logger'
import {
  OLLAMA_LIBRARY,
  deleteOllamaModel,
  listOllamaInstalled,
  normalizeOllamaModelRef,
  pullOllamaModel,
  resolveInstalledOllamaName
} from '../services/ollama'

const OLLAMA_ID = 'ollama'

function ollamaBaseUrl(): string {
  const settings = getResolvedSettings(appState.currentWorkspace)
  const conn = settings.models.connections.find(
    (c) => c.type !== 'builtin' && (c.provider === 'ollama' || c.id === OLLAMA_ID)
  )
  return conn?.baseUrl || 'http://127.0.0.1:11434/v1'
}

/** Add a freshly pulled model to the Ollama connection so chat can route to it. */
function registerModelOnConnection(name: string): void {
  const settings = getResolvedSettings(appState.currentWorkspace)
  const connections = settings.models.connections.map((c) => c)
  const idx = connections.findIndex(
    (c) => c.type !== 'builtin' && (c.provider === 'ollama' || c.id === OLLAMA_ID)
  )
  if (idx < 0) {
    connections.push({
      id: OLLAMA_ID,
      name: 'Ollama',
      type: 'openai-compatible',
      provider: 'ollama',
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyRef: '',
      models: [name]
    })
  } else {
    const conn = connections[idx]!
    if (!conn.models.includes(name)) {
      connections[idx] = { ...conn, models: [...conn.models, name] }
    }
  }
  setSettings('user', { models: { connections } }, appState.currentWorkspace)
}

export function registerOllamaIpc(): void {
  ipcMain.handle('ollama:library', () => OLLAMA_LIBRARY)

  ipcMain.handle('ollama:installed', async () => {
    try {
      return { ok: true, models: await listOllamaInstalled(ollamaBaseUrl()) }
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : 'Unreachable' }
    }
  })

  ipcMain.handle('ollama:pull', async (event, name: string) => {
    const model = normalizeOllamaModelRef(name)
    if (!model) return { ok: false, error: 'Model name is required' }
    logInfo('Ollama pull start', { model })
    try {
      const baseUrl = ollamaBaseUrl()
      await pullOllamaModel(
        model,
        (p) => event.sender.send('ollama:pull-progress', p),
        { baseUrl }
      )
      let registered = model
      try {
        const installed = await listOllamaInstalled(baseUrl)
        registered = resolveInstalledOllamaName(model, installed)
      } catch {
        /* still register the requested name */
      }
      registerModelOnConnection(registered)
      logInfo('Ollama pull complete', { model: registered })
      return { ok: true, model: registered }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pull failed'
      logWarn('Ollama pull failed', { model, error: message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('ollama:delete', async (_e, name: string) => {
    const model = normalizeOllamaModelRef(name)
    if (!model) return { ok: false, error: 'Model name is required' }
    try {
      await deleteOllamaModel(model, ollamaBaseUrl())
      // Drop it from the connection's model list too.
      const settings = getResolvedSettings(appState.currentWorkspace)
      const connections = settings.models.connections.map((c) =>
        c.type !== 'builtin' && (c.provider === 'ollama' || c.id === OLLAMA_ID)
          ? { ...c, models: c.models.filter((m) => m !== model) }
          : c
      )
      setSettings('user', { models: { connections } }, appState.currentWorkspace)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' }
    }
  })
}
