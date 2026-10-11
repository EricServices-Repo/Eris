import { ipcMain } from 'electron'
import { getResolvedSettings } from '../services/settings'
import { completeAtCursor, inlineEdit } from '../services/inline-ai'
import { appState } from '../app-state'
import { getSecret, completeControllers, abortAllCompletes } from './shared'

export function registerAiIpc(): void {
  ipcMain.handle(
    'ai:complete',
    async (
      _e,
      payload: {
        path: string
        language: string
        prefix: string
        suffix: string
        requestId?: string
      }
    ) => {
      // Don't steal the llama sequence while Composer is streaming.
      if (appState.chatStreamActive) {
        return { ok: false, error: 'Busy', requestId: payload.requestId }
      }
      const settings = getResolvedSettings(appState.currentWorkspace)
      const requestId = payload.requestId || `complete-${Date.now()}`
      abortAllCompletes()
      const ac = new AbortController()
      completeControllers.set(requestId, ac)
      try {
        const result = await completeAtCursor({
          settings,
          getSecret,
          path: payload.path,
          language: payload.language,
          prefix: payload.prefix,
          suffix: payload.suffix,
          signal: ac.signal
        })
        return { ...result, requestId }
      } finally {
        completeControllers.delete(requestId)
      }
    }
  )

  ipcMain.handle('ai:completeCancel', (_e, requestId?: string) => {
    if (requestId) {
      completeControllers.get(requestId)?.abort()
      completeControllers.delete(requestId)
    } else {
      abortAllCompletes()
    }
    return { ok: true }
  })

  ipcMain.handle(
    'ai:inlineEdit',
    async (
      _e,
      payload: {
        path: string
        language: string
        selection: string
        instruction: string
        before?: string
        after?: string
      }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      return inlineEdit({
        settings,
        getSecret,
        path: payload.path,
        language: payload.language,
        selection: payload.selection,
        instruction: payload.instruction,
        before: payload.before,
        after: payload.after
      })
    }
  )
}
