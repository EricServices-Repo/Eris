import { ipcMain } from 'electron'
import { appState } from '../app-state'
import {
  applyCloudJobArtifacts,
  cloudAgentsHealth,
  cloudJobToBackgroundJob,
  collectWorkspaceFilesForCloud,
  enqueueCloudJob,
  fetchCloudJobArtifacts,
  getCloudJob,
  listCloudJobs,
  stopCloudJob,
  cloudAgentsBaseUrl
} from '../services/cloud-agents-client'
import type { EnqueueCloudJobRequest } from '../../../src/shared/cloud-agents'
import { getResolvedSettings } from '../services/settings'
import { isEricServicesAuthenticated } from '../services/ericservices'
import { assertCloudJobWithinPlan } from '../services/eris-entitlements'
import { recordCloudJobEnqueue } from '../services/usage-stats'
import { getSecret } from './shared'

function requireCloudAuth(): void {
  if (!ericServicesCloudAuth()) {
    throw new Error(
      'Sign in to EricServic.es (Settings → Account) to use Cloud Agents. Local agents remain available.'
    )
  }
}

function ericServicesCloudAuth(): boolean {
  const settings = getResolvedSettings(appState.currentWorkspace)
  const token = settings.ericServices.tokenRef
    ? getSecret(settings.ericServices.tokenRef)
    : null
  return isEricServicesAuthenticated(settings, token)
}

export function registerCloudAgentsIpc(): void {
  ipcMain.handle('cloudAgents:baseUrl', () => cloudAgentsBaseUrl())

  ipcMain.handle('cloudAgents:health', async () =>
    cloudAgentsHealth(ericServicesCloudAuth())
  )

  ipcMain.handle('cloudAgents:list', async () => {
    if (!ericServicesCloudAuth()) return []
    const jobs = await listCloudJobs(50)
    const ws = appState.currentWorkspace || ''
    return jobs.map((j) => cloudJobToBackgroundJob(j, ws))
  })

  ipcMain.handle('cloudAgents:get', async (_e, id: string) => {
    if (!ericServicesCloudAuth()) return null
    const rawId = String(id).replace(/^cloud:/, '')
    const job = await getCloudJob(rawId)
    if (!job) return null
    return cloudJobToBackgroundJob(job, appState.currentWorkspace || '')
  })

  ipcMain.handle('cloudAgents:enqueue', async (_e, payload: EnqueueCloudJobRequest) => {
    requireCloudAuth()
    const workspace = appState.currentWorkspace
    const settings = getResolvedSettings(workspace)
    assertCloudJobWithinPlan(settings, getSecret)
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

    // Cloud worker always runs Composer Full (7B). Desktop stays on Composer Lite.
    const job = await enqueueCloudJob({
      goal: payload.goal,
      agentId: payload.agentId,
      model: 'composer',
      repoUrl,
      branch,
      claim: payload.claim,
      files
    })
    try {
      recordCloudJobEnqueue()
    } catch {
      /* ignore accounting failures */
    }
    return cloudJobToBackgroundJob(job, workspace || '')
  })

  ipcMain.handle('cloudAgents:stop', async (_e, id: string) => {
    requireCloudAuth()
    const rawId = String(id).replace(/^cloud:/, '')
    return stopCloudJob(rawId)
  })

  ipcMain.handle('cloudAgents:artifacts', async (_e, id: string) => {
    requireCloudAuth()
    return fetchCloudJobArtifacts(String(id))
  })

  /** Fetch cloud patch bundle and apply into the open workspace (Diff Review). */
  ipcMain.handle('cloudAgents:applyArtifacts', async (_e, id: string) => {
    requireCloudAuth()
    const workspace = appState.currentWorkspace
    if (!workspace) throw new Error('Open a workspace to apply cloud changes')
    return applyCloudJobArtifacts(workspace, String(id))
  })
}
