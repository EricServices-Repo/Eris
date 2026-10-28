import { stopDebug } from '../services/debug-service'
import { getResolvedSettings } from '../services/settings'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../services/workspace-watcher'
import { disposeMcpRuntime, syncMcpRuntime } from '../services/mcp-runtime'
import { ensureCodeIndexAsync } from '../services/code-index'
import { disposePtySession } from '../services/pty-session'
import { disposeLanguageServers, configureLanguageServers } from '../services/language-servers'
import { appState } from '../app-state'

export { getSecret, storeSecret } from '../services/credentials'

export const refreshIntelligence = () => {
  disposePtySession()
  void stopDebug().catch(() => undefined)
  void disposeLanguageServers()
  if (!appState.currentWorkspace) {
    stopWorkspaceWatcher()
    void disposeMcpRuntime()
    return
  }
  startWorkspaceWatcher(appState.currentWorkspace)
  const settings = getResolvedSettings(appState.currentWorkspace)
  configureLanguageServers(settings, appState.currentWorkspace)
  void syncMcpRuntime(settings, appState.currentWorkspace).catch(() => undefined)
  // Index off the interactive path — open workspace should not wait on it.
  setImmediate(() => {
    try {
      if (appState.currentWorkspace)
        void ensureCodeIndexAsync(appState.currentWorkspace).catch(() => undefined)
    } catch {
      // optional
    }
  })
}

export const completeControllers = new Map<string, AbortController>()
export const abortAllCompletes = () => {
  for (const [id, ac] of completeControllers) {
    ac.abort()
    completeControllers.delete(id)
  }
}
