import { ipcMain } from 'electron'
import { appState } from '../app-state'
import {
  cloudAgentsHealth,
  cloudJobToBackgroundJob,
  collectWorkspaceFilesForCloud,
  enqueueCloudJob,
  getCloudJob,
  listCloudJobs,
  stopCloudJob,
  cloudAgentsBaseUrl
} from '../services/cloud-agents-client'
import type { EnqueueCloudJobRequest } from '../../../src/shared/cloud-agents'
import { getResolvedSettings } from '../services/settings'

export function registerCloudAgentsIpc(): void {
  ipcMain.handle('cloudAgents:baseUrl', () => cloudAgentsBaseUrl())

  ipcMain.handle('cloudAgents:health', async () => cloudAgentsHealth())

  ipcMain.handle('cloudAgents:list', async () => {
    const jobs = await listCloudJobs(50)
    const ws = appState.currentWorkspace || ''
    return jobs.map((j) => cloudJobToBackgroundJob(j, ws))
  })

  ipcMain.handle('cloudAgents:get', async (_e, id: string) => {
    const rawId = String(id).replace(/^cloud:/, '')
    const job = await getCloudJob(rawId)
    if (!job) return null
    return cloudJobToBackgroundJob(job, appState.currentWorkspace || '')
  })

  ipcMain.handle('cloudAgents:enqueue', async (_e, payload: EnqueueCloudJobRequest) => {
    const workspace = appState.currentWorkspace
    const settings = getResolvedSettings(workspace)
    const files =
      payload.files && payload.files.length > 0
        ? payload.files
        : workspace
          ? collectWorkspaceFilesForCloud(workspace)
          : []

    let repoUrl = payload.repoUrl || null
    let branch = payload.branch || null
    if (!repoUrl && settings.github.linked && settings.github.repository) {
      const host = settings.github.host || 'github.com'
      repoUrl = `https://${host}/${settings.github.repository}.git`
      branch = branch || settings.github.defaultBranch || 'main'
    }

    const job = await enqueueCloudJob({
      goal: payload.goal,
      agentId: payload.agentId,
      model: payload.model || settings.models.defaultModel,
      repoUrl,
      branch,
      claim: payload.claim,
      files
    })
    return cloudJobToBackgroundJob(job, workspace || '')
  })

  ipcMain.handle('cloudAgents:stop', async (_e, id: string) => {
    const rawId = String(id).replace(/^cloud:/, '')
    return stopCloudJob(rawId)
  })
}
