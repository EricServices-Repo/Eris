/**
 * Run a Cloud Agent job and stream progress into the same chat event shape
 * as the local agent loop (thinking / status / tools / answer / diffs).
 */
import type { AppSettings } from '../../../src/shared/settings-schema'
import {
  shouldUseCloudAgents,
  type CloudJob,
  type CloudJobToolEvent
} from '../../../src/shared/cloud-agents'
import {
  applyCloudJobArtifacts,
  cloudAgentsHealth,
  collectWorkspaceFilesForCloud,
  enqueueCloudJob,
  getCloudJob,
  setCloudAgentsAuthToken,
  stopCloudJob
} from './cloud-agents-client'
import { isEricServicesAuthenticated } from './ericservices'
import { logInfo, logWarn } from './logger'
import { recordCloudJobEnqueue } from './usage-stats'

export type CloudInlineEvent =
  | { type: 'thinking'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'status'; text: string }
  | { type: 'model'; model: string; agentId?: string; agentName?: string }
  | {
      type: 'tool'
      tool: {
        id: string
        name: string
        path?: string
        status: 'running' | 'ok' | 'error'
        detail: string
      }
    }
  | {
      type: 'diff'
      diff: {
        checkpointId: string
        opIndex: number
        path: string
        before: string | null
        after: string
        op: 'write'
      }
    }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'workspace-changed' }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      return
    }
    const t = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function syncAuth(settings: AppSettings, getSecret: (ref: string) => string | null): boolean {
  const token = settings.ericServices.tokenRef
    ? getSecret(settings.ericServices.tokenRef)
    : null
  const ok = isEricServicesAuthenticated(settings, token)
  setCloudAgentsAuthToken(ok ? token : null)
  return ok
}

/**
 * Returns true if Cloud can take this Agent-mode turn (caller falls back to local if false).
 */
export async function cloudInlineAvailable(
  settings: AppSettings,
  getSecret: (ref: string) => string | null
): Promise<boolean> {
  if (!syncAuth(settings, getSecret)) return false
  try {
    const health = await cloudAgentsHealth(true)
    return shouldUseCloudAgents(health)
  } catch {
    return false
  }
}

export async function* runCloudAgentInline(options: {
  workspacePath: string
  settings: AppSettings
  goal: string
  agentId?: string | null
  agentName?: string
  getSecret: (ref: string) => string | null
  signal?: AbortSignal
}): AsyncGenerator<CloudInlineEvent> {
  const { workspacePath, settings, goal, agentId, agentName, getSecret, signal } = options
  if (!syncAuth(settings, getSecret)) {
    throw new Error('Sign in to EricServic.es to use Cloud Agents')
  }

  yield {
    type: 'model',
    model: 'composer',
    agentId: agentId || undefined,
    agentName: agentName || undefined
  }
  yield { type: 'thinking', text: 'Routing to Cloud Composer…\n' }
  yield { type: 'status', text: 'Starting Cloud Agent…' }

  const files = collectWorkspaceFilesForCloud(workspacePath)
  let repoUrl: string | null = null
  let branch: string | null = null
  if (settings.github.linked && settings.github.repository) {
    const host = settings.github.host || 'github.com'
    repoUrl = `https://${host}/${settings.github.repository}.git`
    branch = settings.github.defaultBranch || 'main'
  }
  const githubToken = settings.github.tokenRef
    ? getSecret(settings.github.tokenRef)
    : null

  const job = await enqueueCloudJob({
    goal,
    agentId,
    model: 'composer',
    claim: goal.slice(0, 64),
    files,
    repoUrl,
    branch,
    githubToken: githubToken || undefined
  })
  try {
    recordCloudJobEnqueue()
  } catch {
    /* ignore accounting failures */
  }
  logInfo('Cloud inline job started', { id: job.id, files: files.length })

  let lastThinking = ''
  let lastLive = ''
  let lastAnswer = ''
  const seenTools = new Map<string, string>()
  let current: CloudJob = job

  const emitTool = function* (t: CloudJobToolEvent): Generator<CloudInlineEvent> {
    const key = `${t.id}:${t.status}`
    if (seenTools.get(t.id) === t.status) return
    seenTools.set(t.id, t.status)
    yield {
      type: 'tool',
      tool: {
        id: t.id,
        name: t.name,
        path: t.path,
        status: t.status,
        detail: t.detail || ''
      }
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        await stopCloudJob(current.id).catch(() => undefined)
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
      }

      const next = await getCloudJob(current.id)
      if (next) current = next

      if (current.liveStatus && current.liveStatus !== lastLive) {
        lastLive = current.liveStatus
        yield { type: 'status', text: current.liveStatus }
      }

      const thinking = current.thinkingTail || ''
      if (thinking.length > lastThinking.length) {
        const chunk = thinking.slice(lastThinking.length)
        lastThinking = thinking
        yield { type: 'thinking', text: chunk }
      } else if (thinking && thinking !== lastThinking) {
        // Tail window slid — send a short separator + new tail
        lastThinking = thinking
        yield { type: 'thinking', text: `\n${thinking.slice(-800)}` }
      }

      for (const t of current.recentTools || []) {
        yield* emitTool(t)
      }

      const answer = current.answer || ''
      if (answer.length > lastAnswer.length) {
        const chunk = answer.slice(lastAnswer.length)
        lastAnswer = answer
        yield { type: 'answer', text: chunk }
      }

      if (
        current.status === 'done' ||
        current.status === 'failed' ||
        current.status === 'stopped'
      ) {
        break
      }

      await sleep(900, signal)
    }

    if (current.status === 'failed') {
      throw new Error(current.error || 'Cloud Agent failed')
    }
    if (current.status === 'stopped') {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }

    // Final answer if not streamed yet
    if (current.answer && current.answer !== lastAnswer) {
      yield { type: 'answer', text: current.answer.slice(lastAnswer.length) || current.answer }
    }

    if (current.hasArtifacts || (current.artifactCount && current.artifactCount > 0)) {
      yield { type: 'status', text: 'Applying file changes…' }
      const applied = await applyCloudJobArtifacts(workspacePath, current.id)
      if (applied.ok && applied.diffs.length) {
        yield { type: 'checkpoint', checkpointId: applied.checkpointId }
        for (const d of applied.diffs) {
          yield {
            type: 'diff',
            diff: {
              checkpointId: d.checkpointId,
              opIndex: d.opIndex,
              path: d.path,
              before: d.before,
              after: d.after,
              op: 'write'
            }
          }
        }
        yield { type: 'workspace-changed' }
        yield {
          type: 'thinking',
          text: `\nApplied ${applied.diffs.length} file${applied.diffs.length === 1 ? '' : 's'} — review in Diff Review.\n`
        }
      } else if (applied.error) {
        logWarn('Cloud inline apply artifacts', { error: applied.error })
        yield { type: 'status', text: `Artifacts: ${applied.error}` }
      }
    }

    yield { type: 'status', text: 'Done' }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      await stopCloudJob(current.id).catch(() => undefined)
    }
    throw err
  }
}
