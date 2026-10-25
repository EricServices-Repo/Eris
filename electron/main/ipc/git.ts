import { ipcMain } from 'electron'
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCommitReviewed,
  type ReviewedCommitRequest,
  gitDiff,
  gitStage,
  gitStash,
  gitStatus,
  runGit
} from '../services/git-service'
import { acquireProjectWrite } from '../services/agent/task-scheduler'
import { appState } from '../app-state'

export function registerGitIpc(): void {
  ipcMain.handle('git:commitReviewed', async (_event, input: ReviewedCommitRequest) => {
    const root = appState.currentWorkspace
    if (!root || input?.root !== root) throw new Error('Workspace changed; review again')
    const release = await acquireProjectWrite(root)
    try {
      return await gitCommitReviewed(root, input, () => appState.currentWorkspace === root)
    } finally {
      release()
    }
  })
  ipcMain.handle('git:head', async () => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    const result = await runGit(appState.currentWorkspace, ['rev-parse', 'HEAD'])
    if (result.code) throw new Error(result.stderr || 'Cannot resolve HEAD')
    return result.stdout.trim()
  })
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

  ipcMain.handle('git:checkout', async (_e, payload: { branch: string; create?: boolean }) => {
    if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
    return gitCheckout(appState.currentWorkspace, payload.branch, Boolean(payload.create))
  })

  ipcMain.handle(
    'git:stash',
    async (_e, payload?: { action?: 'push' | 'pop' | 'list'; message?: string }) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
      return gitStash(appState.currentWorkspace, payload?.action || 'push', payload?.message)
    }
  )
}
