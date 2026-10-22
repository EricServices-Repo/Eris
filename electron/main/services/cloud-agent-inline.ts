import type { TaskContract } from '../../../src/shared/task-contract'
/**
 * Run a Cloud Agent job and stream progress into the same chat event shape
 * as the local agent loop (thinking / status / tools / answer / diffs).
 */
import type { AppSettings } from '../../../src/shared/settings-schema'
import {
  isCloudAgentsReady,
  shouldUseCloudAgents,
  type CloudHealth,
  type CloudJob
} from '../../../src/shared/cloud-agents'
import {
  applyCloudJobArtifacts,
  cloudAgentsHealth,
  collectWorkspaceFilesForCloud,
  enqueueCloudJob,
  getCloudJob,
  setCloudAgentsAuthToken,
  stopCloudJob,
  watchCloudJob
} from './cloud-agents-client'
import { isEricServicesAuthenticated } from './ericservices'
import { logInfo, logWarn } from './logger'
import { activeDiagnosticsScope } from './model-transport'
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
  const token = settings.ericServices.tokenRef ? getSecret(settings.ericServices.tokenRef) : null
  const ok = isEricServicesAuthenticated(settings, token)
  setCloudAgentsAuthToken(ok ? token : null)
  return ok
}

let healthCache: { at: number; health: CloudHealth } | null = null
const HEALTH_CACHE_MS = 20_000

async function refreshInlineHealth(force = false): Promise<CloudHealth | null> {
  if (!force && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.health
  }
  try {
    const health = await cloudAgentsHealth(true)
    healthCache = { at: Date.now(), health }
    return health
  } catch {
    return null
  }
}

/**
 * Prefetch Cloud health after login so the first Agent turn is less cold
 * (TLS, auth, model status). Best-effort — never throws.
 */
export async function prefetchCloudAgentsWarm(
  settings: AppSettings,
  getSecret: (ref: string) => string | null
): Promise<void> {
  if (!syncAuth(settings, getSecret)) return
  healthCache = null
  await refreshInlineHealth(true)
  // Second probe a moment later catches model status flipping to ready/downloading.
  void sleep(1_500)
    .then(() => refreshInlineHealth(true))
    .catch(() => undefined)
}

/**
 * Returns true if Cloud can take this Agent-mode turn (caller falls back to local if false).
 */
export async function cloudInlineAvailable(
  settings: AppSettings,
  getSecret: (ref: string) => string | null,
  requiredTaskVersion = 1
): Promise<boolean> {
  // Cloud Agents is a model provider outside the scope's adapter. Refuse before
  // the health probe, so the turn stays on the local loop and its adapter.
  const diagnostics = activeDiagnosticsScope()
  if (diagnostics) {
    diagnostics.onBlockedEffect('cloud', 'Cloud Composer inline')
    return false
  }
  if (!syncAuth(settings, getSecret)) return false
  try {
    const health = await refreshInlineHealth(false)
    return (
      shouldUseCloudAgents(health) &&
      (requiredTaskVersion === 1 || (health?.taskContractVersion ?? 1) >= requiredTaskVersion)
    )
  } catch {
    return false
  }
}

function* emitJobDelta(
  current: CloudJob,
  state: {
    lastThinking: string
    lastLive: string
    lastAnswer: string
    seenTools: Map<string, string>
  }
): Generator<CloudInlineEvent> {
  if (current.liveStatus && current.liveStatus !== state.lastLive) {
    state.lastLive = current.liveStatus
    yield { type: 'status', text: current.liveStatus }
  }

  const thinking = current.thinkingTail || ''
  if (thinking.length > state.lastThinking.length) {
    const chunk = thinking.slice(state.lastThinking.length)
    state.lastThinking = thinking
    yield { type: 'thinking', text: chunk }
  } else if (thinking && thinking !== state.lastThinking) {
    state.lastThinking = thinking
    yield { type: 'thinking', text: `\n${thinking.slice(-800)}` }
  }

  for (const t of current.recentTools || []) {
    if (state.seenTools.get(t.id) === t.status) continue
    state.seenTools.set(t.id, t.status)
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

  const answer = current.answer || ''
  if (answer.length > state.lastAnswer.length) {
    const chunk = answer.slice(state.lastAnswer.length)
    state.lastAnswer = answer
    yield { type: 'answer', text: chunk }
  }
}

async function* pollJobUntilDone(jobId: string, signal?: AbortSignal): AsyncGenerator<CloudJob> {
  while (true) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    const next = await getCloudJob(jobId)
    if (next) {
      yield next
      if (next.status === 'done' || next.status === 'failed' || next.status === 'stopped') {
        return
      }
    }
    await sleep(2000, signal)
  }
}

export async function* runCloudAgentInline(options: {
  task?: TaskContract
  workspacePath: string
  settings: AppSettings
  goal: string
  agentId?: string | null
  agentName?: string
  getSecret: (ref: string) => string | null
  signal?: AbortSignal
}): AsyncGenerator<CloudInlineEvent> {
  const { workspacePath, settings, goal, agentId, agentName, getSecret, signal } = options
  const diagnostics = activeDiagnosticsScope()
  if (diagnostics) {
    diagnostics.onBlockedEffect('cloud', 'Cloud Agent execution refused')
    throw new Error('Cloud Agents are disabled in diagnostics runs')
  }
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

  const health = await refreshInlineHealth(false)
  const cloudWarming = Boolean(
    health && shouldUseCloudAgents(health) && !isCloudAgentsReady(health)
  )
  if (cloudWarming) {
    const detail =
      health?.localModel?.status === 'downloading'
        ? 'Composer Full downloading on cloud…'
        : 'Composer Full warming on cloud…'
    yield { type: 'status', text: detail }
    yield { type: 'thinking', text: `— ${detail}\n` }
  }

  let repoUrl: string | null = null
  let branch: string | null = null
  if (settings.github.linked && settings.github.repository) {
    const host = settings.github.host || 'github.com'
    repoUrl = `https://${host}/${settings.github.repository}.git`
    branch = settings.github.defaultBranch || 'main'
  }
  const githubToken = settings.github.tokenRef ? getSecret(settings.github.tokenRef) : null

  // Prefer clone over shipping file bodies — avoids multi‑MB seed + dual workspace prep.
  const files = repoUrl && githubToken ? [] : collectWorkspaceFilesForCloud(workspacePath)

  const job = await enqueueCloudJob({
    task: options.task,
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
  logInfo('Cloud inline job started', {
    id: job.id,
    files: files.length,
    clone: Boolean(repoUrl && githubToken),
    warming: cloudWarming
  })

  const state = {
    lastThinking: '',
    lastLive: cloudWarming ? 'Composer Full warming on cloud…' : '',
    lastAnswer: '',
    seenTools: new Map<string, string>()
  }
  let current: CloudJob = job
  yield* emitJobDelta(current, state)
  if (
    cloudWarming &&
    !current.liveStatus &&
    (current.status === 'queued' || current.status === 'running')
  ) {
    yield { type: 'status', text: 'Composer Full warming on cloud…' }
  }

  try {
    let stream: AsyncGenerator<CloudJob>
    try {
      stream = watchCloudJob(job.id, signal)
    } catch {
      stream = pollJobUntilDone(job.id, signal)
    }

    try {
      for await (const next of stream) {
        if (signal?.aborted) {
          await stopCloudJob(current.id).catch(() => undefined)
          throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
        }
        current = next
        yield* emitJobDelta(current, state)
        if (
          current.status === 'done' ||
          current.status === 'failed' ||
          current.status === 'stopped'
        ) {
          break
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      // SSE failed mid-job — finish via poll
      logWarn('Cloud inline SSE fallback to poll', {
        id: job.id,
        error: err instanceof Error ? err.message : String(err)
      })
      if (
        current.status !== 'done' &&
        current.status !== 'failed' &&
        current.status !== 'stopped'
      ) {
        for await (const next of pollJobUntilDone(job.id, signal)) {
          current = next
          yield* emitJobDelta(current, state)
        }
      }
    }

    if (current.status === 'failed') {
      throw new Error(current.error || 'Cloud Agent failed')
    }
    if (current.status === 'stopped') {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }

    if (current.answer && current.answer !== state.lastAnswer) {
      yield {
        type: 'answer',
        text: current.answer.slice(state.lastAnswer.length) || current.answer
      }
    }

    if (current.hasArtifacts || (current.artifactCount && current.artifactCount > 0)) {
      yield { type: 'status', text: 'Applying file changes…' }
      const applied = await applyCloudJobArtifacts(workspacePath, current.id, options.task)
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
          text: `\n— Applied ${applied.diffs.length} file${applied.diffs.length === 1 ? '' : 's'}\n`
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
