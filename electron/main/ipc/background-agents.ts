import { ipcMain } from 'electron'
import { appState } from '../app-state'
import { getSecret } from './shared'
import type { EnqueueBackgroundJobRequest } from '../../../src/shared/background-agents'
import { formatJobResultForChat } from '../../../src/shared/agent-orchestration'
import {
  backgroundJobDiff,
  bringJobIntoChat,
  configureBackgroundAgents,
  discardBackgroundJob,
  enqueueBackgroundJob,
  listBackgroundJobs,
  mergeBackgroundJob,
  onBackgroundJobEvent,
  stopBackgroundJob
} from '../services/background-agents'
import { getCloudJob } from '../services/cloud-agents-client'
import { appendMessage, createChat, getChat } from '../services/chats'

export function registerBackgroundAgentsIpc(): void {
  onBackgroundJobEvent((event) => {
    const win = appState.mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send('agents:job', event)
  })

  ipcMain.handle('agents:jobs', () => listBackgroundJobs(appState.currentWorkspace))
  ipcMain.handle('agents:enqueue', (event, payload: EnqueueBackgroundJobRequest) => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace first')
    configureBackgroundAgents({ sender: event.sender, getSecret })
    return enqueueBackgroundJob(appState.currentWorkspace, payload)
  })
  ipcMain.handle('agents:stopJob', (_e, id: string) => stopBackgroundJob(String(id)))
  ipcMain.handle('agents:discardJob', (_e, id: string) => discardBackgroundJob(String(id)))
  ipcMain.handle('agents:mergeJob', (_e, id: string) => mergeBackgroundJob(String(id)))
  ipcMain.handle('agents:jobDiff', (_e, id: string) => backgroundJobDiff(String(id)))
  ipcMain.handle(
    'agents:bringToChat',
    async (_e, id: string, threadId?: string | null) => {
      const raw = String(id)
      if (raw.startsWith('cloud:')) {
        const job = await getCloudJob(raw.replace(/^cloud:/, ''))
        if (!job) return { ok: false, threadId: '', content: '', error: 'Cloud job not found' }
        const content = formatJobResultForChat({
          goal: job.goal,
          agentName: job.agentName,
          status: job.status,
          answer: job.answer,
          filesTouched: job.filesTouched,
          routeReason: 'Cloud · agents.ericservic.es:443 (https)'
        })
        try {
          let thread = threadId ? getChat(appState.currentWorkspace, threadId) : null
          if (!thread) {
            thread = createChat(appState.currentWorkspace, job.model || 'builtin:composer-lite')
          }
          const saved = appendMessage(
            appState.currentWorkspace,
            thread.id,
            'assistant',
            content
          )
          return { ok: true, threadId: saved.id, content }
        } catch (err) {
          return {
            ok: false,
            threadId: '',
            content,
            error: err instanceof Error ? err.message : String(err)
          }
        }
      }
      return bringJobIntoChat(appState.currentWorkspace, raw, threadId ?? null)
    }
  )
}
