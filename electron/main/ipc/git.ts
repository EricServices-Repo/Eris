import { ipcMain } from 'electron'
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiff,
  gitStage,
  gitStash,
  gitStatus
} from '../services/git-service'
import { appState } from '../app-state'

export function registerGitIpc(): void {
  ipcMain.handle('git:status', async () => {
    if (!appState.currentWorkspace) {
      return {
        ok: false,
        error: 'No workspace open',
        branch: null,
        ahead: 0,
        behind: 0,
        entries: []
      }
    }
    return gitStatus(appState.currentWorkspace)
  })

  ipcMain.handle('git:diff', async (_e, path?: string) => {
    if (!appState.currentWorkspace) return { ok: false, diff: '', error: 'No workspace open' }
    return gitDiff(appState.currentWorkspace, path)
  })

  ipcMain.handle('git:stage', async (_e, paths: string[]) => {
    if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
    return gitStage(appState.currentWorkspace, paths)
  })

  ipcMain.handle('git:commit', async (_e, message: string) => {
    if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
    return gitCommit(appState.currentWorkspace, message)
  })

  ipcMain.handle('git:branches', async () => {
    if (!appState.currentWorkspace) {
      return { ok: false, current: null, branches: [], error: 'No workspace open' }
    }
    return gitBranches(appState.currentWorkspace)
  })

  ipcMain.handle(
    'git:checkout',
    async (_e, payload: { branch: string; create?: boolean }) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
      return gitCheckout(appState.currentWorkspace, payload.branch, Boolean(payload.create))
    }
  )

  ipcMain.handle(
    'git:stash',
    async (_e, payload?: { action?: 'push' | 'pop' | 'list'; message?: string }) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
      return gitStash(
        appState.currentWorkspace,
        payload?.action || 'push',
        payload?.message
      )
    }
  )
}
