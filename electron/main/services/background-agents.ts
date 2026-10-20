import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type { AppSettings } from '../../../src/shared/settings-schema'
import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobToolEvent,
  EnqueueBackgroundJobRequest
} from '../../../src/shared/background-agents'
import {
  deriveBlackboardStatus,
  summarizeAgentResults,
  formatHandoffForPrompt,
  formatJobResultForChat,
  type AgentHandoffPacket,
  type AgentRouteStep
} from '../../../src/shared/agent-orchestration'
import { runAgentWithWorkspaceTools } from './agent-runner'
import { planChatTurn } from './chat-router'
import { userDataRoot } from './paths'
import {
  addWorkspaceAllowedCommand,
  workspaceAllowedCommands,
  workspaceKey
} from './workspace-trust'
import { addAgentWorktree, diffWorktree, mergeAgentBranch, removeAgentWorktree } from './worktrees'
import { logError, logInfo } from './logger'
import {
  commandNeedsApproval,
  formatMcpApprovalPreview,
  normalizeCommand,
  requestCommandApproval
} from './command-approval'
import { getResolvedSettings } from './settings'
import { appendMessage, createChat, getChat } from './chats'
import { findAgent } from './agents'

const jobs = new Map<string, BackgroundJob>()
const aborts = new Map<string, AbortController>()
const listeners = new Set<(event: BackgroundJobEvent) => void>()
let pumping = false
const MAX_TOOLS = 40
const MAX_THINKING = 4000

function storePath(): string {
  return join(userDataRoot(), 'background-jobs.json')
}

function persist(): void {
  mkdirSync(userDataRoot(), { recursive: true })
  writeFileSync(storePath(), JSON.stringify({ jobs: [...jobs.values()] }, null, 2), 'utf8')
}

function loadPersisted(): void {
  if (jobs.size > 0) return
  try {
    if (!existsSync(storePath())) return
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as { jobs?: BackgroundJob[] }
    for (const job of raw.jobs ?? []) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'stopped'
        job.error = job.error || 'Interrupted when Eris quit'
        job.updatedAt = new Date().toISOString()
      }
      job.blackboard = deriveBlackboardStatus(job)
      jobs.set(job.id, job)
    }
  } catch {
    // ignore
  }
}

function emit(event: BackgroundJobEvent): void {
  if (event.type === 'upsert' || event.type === 'removed') persist()
  for (const l of listeners) {
    try {
      l(event)
    } catch {
      // ignore
    }
  }
}

function withBoard(job: BackgroundJob): BackgroundJob {
  return { ...job, blackboard: deriveBlackboardStatus(job) }
}

function upsert(job: BackgroundJob): BackgroundJob {
  job.updatedAt = new Date().toISOString()
  const next = withBoard(job)
  jobs.set(next.id, next)
  emit({ type: 'upsert', job: next })
  return next
}

function patch(id: string, fn: (job: BackgroundJob) => BackgroundJob): BackgroundJob | null {
  const cur = jobs.get(id)
  if (!cur) return null
  return upsert(fn({ ...cur }))
}

function pushRoute(job: BackgroundJob, step: AgentRouteStep): AgentRouteStep[] {
  return [...(job.routeHistory || []), step].slice(-24)
}

export function onBackgroundJobEvent(cb: (event: BackgroundJobEvent) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function listBackgroundJobs(workspacePath: string | null): BackgroundJob[] {
  loadPersisted()
  if (!workspacePath)
    return [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const key = workspaceKey(workspacePath)
  return [...jobs.values()]
    .filter((j) => {
      try {
        return workspaceKey(j.workspacePath) === key
      } catch {
        return j.workspacePath === workspacePath
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getBackgroundJob(id: string): BackgroundJob | null {
  loadPersisted()
  return jobs.get(id) ?? null
}

const pendingHints = new Map<
  string,
  {
    mode: 'ask' | 'agent'
    forceRoute?: 'tools' | 'answer'
    manualAgentId: string | null
  }
>()

export function enqueueBackgroundJob(
  workspacePath: string,
  request: EnqueueBackgroundJobRequest
): BackgroundJob {
  loadPersisted()
  const now = new Date().toISOString()
  const goal = String(request.goal || '').trim()
  if (!goal) throw new Error('Goal is required')

  let worktreePath = ''
  let branch = ''
  const parent = request.parentId ? jobs.get(request.parentId) : null
  if (request.inheritWorktree && parent?.worktreePath && parent.branch) {
    worktreePath = parent.worktreePath
    branch = parent.branch
  }

  const job: BackgroundJob = {
    id: randomUUID(),
    workspacePath,
    worktreePath,
    branch,
    goal,
    model: String(request.model || '').trim() || 'builtin:composer-lite',
    agentId: request.agentId?.trim() || 'auto',
    source: request.source || 'panel',
    sourceThreadId: request.sourceThreadId ?? parent?.sourceThreadId ?? null,
    parentId: request.parentId ?? null,
    childIds: [],
    handoff: request.handoff ?? null,
    claim: request.claim ?? null,
    routeHistory: [],
    escalateCount: 0,
    rerouteCount: 0,
    status: 'queued',
    step: 0,
    actionLog: [],
    filesTouched: [],
    answer: '',
    liveStatus: 'Queued',
    recentTools: [],
    thinkingTail: '',
    createdAt: now,
    updatedAt: now
  }
  pendingHints.set(job.id, {
    mode: request.mode === 'ask' ? 'ask' : 'agent',
    forceRoute: request.forceRoute,
    manualAgentId: request.agentId && request.agentId !== 'auto' ? request.agentId : null
  })
  upsert(job)

  if (parent) {
    patch(parent.id, (p) => ({
      ...p,
      childIds: [...new Set([...(p.childIds || []), job.id])],
      actionLog: [...p.actionLog, `Spawned child ${job.id.slice(0, 8)} → ${job.agentId}`].slice(-80)
    }))
  }

  void pumpQueue()
  return job
}

/** Used by chat + background orchestrators to spawn specialists. */
export function delegateFromAgent(options: {
  workspacePath: string
  parentJobId?: string | null
  sourceThreadId?: string | null
  model: string
  agentId: string
  goal: string
  summary: string
  files?: string[]
  openQuestions?: string[]
  confidence?: number
  claim?: string
  handoff: AgentHandoffPacket
}): BackgroundJob {
  const parent = options.parentJobId ? jobs.get(options.parentJobId) : null
  const inherit = Boolean(parent?.worktreePath)
  return enqueueBackgroundJob(options.workspacePath, {
    goal: options.goal,
    model: options.model || parent?.model || 'builtin:composer-lite',
    agentId: options.agentId,
    mode: 'agent',
    source: 'delegate',
    sourceThreadId: options.sourceThreadId ?? parent?.sourceThreadId ?? null,
    forceRoute: 'tools',
    parentId: options.parentJobId ?? null,
    inheritWorktree: inherit,
    handoff: options.handoff,
    claim: options.claim || `${options.agentId}: ${options.goal.slice(0, 48)}`
  })
}

export async function awaitChildJobs(
  parentId: string,
  timeoutMs = 600_000
): Promise<{ ok: boolean; detail: string }> {
  const parent = jobs.get(parentId)
  if (!parent) return { ok: false, detail: 'Parent job not found' }
  const childIds = [...(parent.childIds || [])]
  if (childIds.length === 0) return { ok: true, detail: 'No children to await' }

  patch(parentId, (j) => ({
    ...j,
    liveStatus: 'Waiting for children…'
  }))
  // A waiting parent releases its slot; immediately wake queued specialists.
  void pumpQueue()

  const deadline = Date.now() + Math.max(5_000, Math.min(timeoutMs, 30 * 60_000))
  const terminal = new Set(['done', 'failed', 'stopped', 'merged', 'discarded'])

  while (Date.now() < deadline) {
    if (aborts.get(parentId)?.signal.aborted) {
      return { ok: false, detail: 'Parent aborted while waiting for children' }
    }
    const children = childIds.map((id) => jobs.get(id)).filter(Boolean) as BackgroundJob[]
    const pending = children.filter((c) => !terminal.has(c.status))
    if (pending.length === 0) {
      patch(parentId, (j) => ({
        ...j,
        liveStatus: 'Children finished',
        filesTouched: [...new Set([...j.filesTouched, ...children.flatMap((c) => c.filesTouched)])]
      }))
      return summarizeAgentResults(childIds.map((id) => jobs.get(id)))
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const still = childIds
    .map((id) => jobs.get(id))
    .filter((c) => c && !terminal.has(c.status))
    .map((c) => `${c!.id.slice(0, 8)}:${c!.status}`)
  return {
    ok: false,
    detail: `Timed out waiting for children: ${still.join(', ') || 'unknown'}`
  }
}

export function stopBackgroundJob(id: string): boolean {
  const ac = aborts.get(id)
  if (ac) {
    ac.abort()
    return true
  }
  const job = jobs.get(id)
  if (job && job.status === 'queued') {
    upsert({
      ...job,
      status: 'stopped',
      error: 'Cancelled before start',
      liveStatus: 'Stopped'
    })
    pendingHints.delete(id)
    return true
  }
  return false
}

export async function discardBackgroundJob(id: string): Promise<BackgroundJob> {
  const job = jobs.get(id)
  if (!job) throw new Error('Job not found')
  stopBackgroundJob(id)
  const shared =
    job.parentId &&
    jobs.get(job.parentId)?.worktreePath &&
    jobs.get(job.parentId)?.worktreePath === job.worktreePath
  if (job.worktreePath && job.branch && !shared) {
    try {
      await removeAgentWorktree(job.workspacePath, { path: job.worktreePath, branch: job.branch })
    } catch {
      // still mark discarded
    }
  }
  return upsert({ ...job, status: 'discarded', liveStatus: 'Discarded' })
}

export async function mergeBackgroundJob(id: string): Promise<BackgroundJob> {
  const job = jobs.get(id)
  if (!job) throw new Error('Job not found')
  if (job.status !== 'done') throw new Error('Only finished jobs can be merged')
  const shared =
    job.parentId &&
    jobs.get(job.parentId)?.worktreePath &&
    jobs.get(job.parentId)?.worktreePath === job.worktreePath
  if (shared) {
    return upsert({
      ...job,
      status: 'merged',
      liveStatus: 'Merged (shared branch with parent)',
      actionLog: [...job.actionLog, 'Marked merged — edits already on parent worktree'].slice(-80)
    })
  }
  const merged = await mergeAgentBranch(job.workspacePath, job.branch)
  if (!merged.ok) throw new Error(merged.error || 'Merge failed')
  try {
    await removeAgentWorktree(job.workspacePath, { path: job.worktreePath, branch: job.branch })
  } catch {
    // branch is already merged
  }
  return upsert({
    ...job,
    status: 'merged',
    liveStatus: 'Merged',
    actionLog: [...job.actionLog, 'Merged into current branch']
  })
}

export async function backgroundJobDiff(
  id: string
): Promise<{ ok: boolean; diff: string; error?: string }> {
  const job = jobs.get(id)
  if (!job?.branch) return { ok: false, diff: '', error: 'Job has no branch' }
  return diffWorktree(job.workspacePath, job.branch)
}

export async function bringJobIntoChat(
  workspacePath: string | null,
  jobId: string,
  threadId?: string | null
): Promise<{ ok: boolean; threadId: string; content: string; error?: string }> {
  loadPersisted()
  const job = jobs.get(jobId)
  if (!job) return { ok: false, threadId: '', content: '', error: 'Job not found' }
  const content = formatJobResultForChat({
    goal: job.goal,
    agentName: job.agentName,
    status: job.blackboard || job.status,
    answer: job.answer,
    filesTouched: job.filesTouched,
    routeReason: job.routeReason,
    handoff: job.handoff
  })
  try {
    let thread = threadId ? await getChat(workspacePath, threadId) : null
    if (!thread) {
      thread = await createChat(workspacePath, job.model || 'builtin:composer-lite')
    }
    const saved = await appendMessage(workspacePath, thread.id, 'assistant', content)
    if (job.sourceThreadId !== saved.id) {
      patch(jobId, (j) => ({ ...j, sourceThreadId: saved.id }))
    }
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

export async function stopAllBackgroundJobs(): Promise<void> {
  for (const id of [...aborts.keys(), ...jobs.keys()]) stopBackgroundJob(id)
}

async function pumpQueue(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    loadPersisted()
    let launched = 0
    const queued = [...jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const byWorkspace = new Map<string, BackgroundJob[]>()
    for (const job of queued) {
      const key = workspaceKey(job.workspacePath)
      const list = byWorkspace.get(key) ?? []
      list.push(job)
      byWorkspace.set(key, list)
    }
    for (const group of byWorkspace.values()) {
      const first = group[0]
      if (!first) continue
      const settings = getResolvedSettings(first.workspacePath)
      const running = [...jobs.values()].filter((j) => {
        if (j.status !== 'running') return false
        if (workspaceKey(j.workspacePath) !== workspaceKey(first.workspacePath)) return false
        // Parents blocked on children free a slot so specialists can run.
        const live = (j.liveStatus || '').toLowerCase()
        if (live.includes('waiting for children')) return false
        return true
      }).length
      const slots = Math.max(0, settings.backgroundAgents.maxParallel - running)
      for (let i = 0; i < slots && i < group.length; i++) {
        const job = group[i]!
        // Claim immediately so parallel pumps / parent await can start siblings.
        patch(job.id, (j) =>
          j.status === 'queued' ? { ...j, status: 'running', liveStatus: 'Planning route…' } : j
        )
        if (getBackgroundJob(job.id)?.status !== 'running') continue
        launched++
        void runOne(job, settings).finally(() => {
          void pumpQueue()
        })
      }
    }
    void launched
  } finally {
    pumping = false
  }
}

async function runOne(job: BackgroundJob, settings: AppSettings): Promise<void> {
  const ac = new AbortController()
  aborts.set(job.id, ac)
  const hints = pendingHints.get(job.id) ?? {
    mode: 'agent' as const,
    manualAgentId: job.agentId !== 'auto' ? job.agentId : null
  }
  pendingHints.delete(job.id)

  try {
    patch(job.id, (j) => ({
      ...j,
      status: 'running',
      liveStatus: j.liveStatus || 'Planning route…'
    }))
    const planText =
      job.handoff != null ? `${formatHandoffForPrompt(job.handoff)}\n\n${job.goal}` : job.goal

    const turnPlan = await planChatTurn({
      workspacePath: job.workspacePath,
      settings,
      context: {
        text: planText,
        selectedModel: job.model,
        mode: hints.mode,
        manualAgentId: hints.manualAgentId,
        forceRoute: hints.forceRoute
      },
      getSecret: currentGetSecret,
      signal: ac.signal
    })

    if (turnPlan.error) {
      upsert({
        ...getBackgroundJob(job.id)!,
        status: 'failed',
        error: turnPlan.error,
        liveStatus: 'Failed',
        agentId: turnPlan.agentId,
        agentName: turnPlan.agentName,
        intent: turnPlan.intent,
        routeReason: turnPlan.reason,
        chatModel: turnPlan.models.chat,
        toolsModel: turnPlan.models.tools,
        routeHistory: pushRoute(getBackgroundJob(job.id)!, {
          at: new Date().toISOString(),
          agentId: turnPlan.agentId,
          agentName: turnPlan.agentName,
          model: turnPlan.models.tools,
          reason: turnPlan.reason,
          kind: 'plan'
        })
      })
      return
    }

    patch(job.id, (j) => ({
      ...j,
      agentId: turnPlan.agentId,
      agentName: turnPlan.agentName,
      intent: turnPlan.intent,
      routeReason: turnPlan.reason,
      chatModel: turnPlan.models.chat,
      toolsModel: turnPlan.models.tools,
      model: turnPlan.models.tools || turnPlan.models.chat || j.model,
      escalateCount: turnPlan.escalateToFull ? 1 : j.escalateCount || 0,
      claim: j.claim || `${turnPlan.agentName}: ${j.goal.slice(0, 48)}`,
      liveStatus: j.worktreePath ? `Running · ${turnPlan.agentName}` : 'Preparing worktree…',
      actionLog: [...j.actionLog, turnPlan.reason].slice(-80),
      routeHistory: pushRoute(j, {
        at: new Date().toISOString(),
        agentId: turnPlan.agentId,
        agentName: turnPlan.agentName,
        model: turnPlan.models.tools,
        reason: turnPlan.reason,
        kind: 'plan'
      })
    }))

    let treePath = getBackgroundJob(job.id)?.worktreePath || ''
    let treeBranch = getBackgroundJob(job.id)?.branch || ''
    if (!treePath || !treeBranch) {
      const tree = await addAgentWorktree(
        job.workspacePath,
        job.id,
        settings.backgroundAgents.linkNodeModules
      )
      treePath = tree.path
      treeBranch = tree.branch
      patch(job.id, (j) => ({
        ...j,
        worktreePath: tree.path,
        branch: tree.branch,
        status: 'running',
        liveStatus: `Running · ${turnPlan.agentName}`
      }))
    } else {
      patch(job.id, (j) => ({
        ...j,
        status: 'running',
        liveStatus: `Running · ${turnPlan.agentName} (shared worktree)`
      }))
    }

    const sender = currentSender
    let thinkingBuf = ''
    let lastUpsert = 0
    const flushThinking = (force = false) => {
      const now = Date.now()
      if (!force && now - lastUpsert < 250) return
      lastUpsert = now
      const cur = getBackgroundJob(job.id)
      if (!cur) return
      upsert({
        ...cur,
        thinkingTail: thinkingBuf.slice(-MAX_THINKING)
      })
    }

    const userContent =
      job.handoff != null ? `${formatHandoffForPrompt(job.handoff)}\n\n${job.goal}` : job.goal

    for await (const evt of runAgentWithWorkspaceTools({
      workspacePath: treePath,
      settings,
      model: turnPlan.models.chat,
      messages: [{ role: 'user', content: userContent }],
      temperature: settings.models.temperature,
      signal: ac.signal,
      getSecret: currentGetSecret,
      mode: hints.mode,
      turnPlan,
      mcp: 'reuse',
      jobId: job.id,
      onDelegate: async (req) => {
        try {
          const child = delegateFromAgent({
            workspacePath: job.workspacePath,
            parentJobId: job.id,
            sourceThreadId: job.sourceThreadId,
            model: getBackgroundJob(job.id)?.model || job.model,
            agentId: req.agentId,
            goal: req.goal,
            summary: req.summary,
            files: req.files,
            openQuestions: req.openQuestions,
            confidence: req.confidence,
            claim: req.claim,
            handoff: req.handoff
          })
          patch(job.id, (j) => ({
            ...j,
            routeHistory: pushRoute(j, {
              at: new Date().toISOString(),
              agentId: req.agentId,
              model: j.model,
              reason: `Delegated: ${req.goal.slice(0, 80)}`,
              kind: 'delegate'
            })
          }))
          // Kick the queue so children can run while parent awaits
          void pumpQueue()
          return {
            ok: true,
            childJobId: child.id,
            detail: `Spawned ${req.agentId} job ${child.id} (claim: ${child.claim || 'n/a'})`
          }
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : String(err)
          }
        }
      },
      onAwaitChildren: (timeoutMs) => awaitChildJobs(job.id, timeoutMs),
      approveCommand: async (kind, command) => {
        const resolved = getResolvedSettings(job.workspacePath)
        const allowed = workspaceAllowedCommands(job.workspacePath)
        if (!commandNeedsApproval(resolved, kind, command, allowed)) return true
        if (!sender || sender.isDestroyed()) return false
        patch(job.id, (j) => ({
          ...j,
          liveStatus: `Waiting for approval: ${command.slice(0, 80)}`
        }))
        const decision = await requestCommandApproval(sender, job.id, kind, command, ac.signal)
        if (decision === 'always') {
          addWorkspaceAllowedCommand(job.workspacePath, normalizeCommand(command))
        }
        patch(job.id, (j) => ({
          ...j,
          liveStatus: decision === 'deny' ? 'Command denied' : 'Running…',
          actionLog: [...j.actionLog, `${decision}: ${command.slice(0, 100)}`].slice(-80)
        }))
        return decision !== 'deny'
      },
      approveMcpTool: async (toolName, args) => {
        if (!sender || sender.isDestroyed()) return false
        patch(job.id, (j) => ({
          ...j,
          liveStatus: `Waiting for MCP approval: ${toolName}`
        }))
        const decision = await requestCommandApproval(
          sender,
          job.id,
          'mcp',
          formatMcpApprovalPreview(args),
          ac.signal,
          { toolName, canAlwaysAllow: false }
        )
        patch(job.id, (j) => ({
          ...j,
          liveStatus: decision === 'deny' ? 'MCP call denied' : 'Running…',
          actionLog: [...j.actionLog, `${decision}: MCP ${toolName}`].slice(-80)
        }))
        return decision !== 'deny'
      }
    })) {
      const cur = getBackgroundJob(job.id)
      if (!cur) break
      if (evt.type === 'answer') {
        upsert({ ...cur, answer: cur.answer + evt.text })
      } else if (evt.type === 'thinking') {
        thinkingBuf += evt.text
        flushThinking()
      } else if (evt.type === 'progress') {
        upsert({
          ...cur,
          step: evt.step,
          actionLog: evt.actionLog,
          filesTouched: evt.filesTouched,
          thinkingTail: thinkingBuf.slice(-MAX_THINKING)
        })
      } else if (evt.type === 'status') {
        upsert({
          ...cur,
          liveStatus: evt.text,
          actionLog: [...cur.actionLog, evt.text].slice(-80)
        })
      } else if (evt.type === 'adapt') {
        upsert({
          ...cur,
          agentId: evt.agentId || cur.agentId,
          agentName: evt.agentName || cur.agentName,
          toolsModel: evt.model || cur.toolsModel,
          model: evt.model || cur.model,
          escalateCount: evt.kind === 'escalate' ? (cur.escalateCount || 0) + 1 : cur.escalateCount,
          rerouteCount: evt.kind === 'reroute' ? (cur.rerouteCount || 0) + 1 : cur.rerouteCount,
          liveStatus: evt.reason,
          routeHistory: pushRoute(cur, {
            at: new Date().toISOString(),
            agentId: evt.agentId || cur.agentId,
            agentName: evt.agentName || cur.agentName,
            model: evt.model || cur.model,
            reason: evt.reason,
            kind: evt.kind === 'delegate' ? 'delegate' : evt.kind
          }),
          childIds:
            evt.childJobId && !(cur.childIds || []).includes(evt.childJobId)
              ? [...(cur.childIds || []), evt.childJobId]
              : cur.childIds
        })
      } else if (evt.type === 'tool') {
        const tool: BackgroundJobToolEvent = {
          id: evt.tool.id,
          name: evt.tool.name,
          path: evt.tool.path,
          status: evt.tool.status,
          effect: evt.tool.effect,
          changedResources: evt.tool.changedResources,
          durationMs: evt.tool.durationMs,
          failure: evt.tool.failure,
          detail: evt.tool.detail.slice(0, 500),
          at: new Date().toISOString()
        }
        const recent = [...(cur.recentTools || []).filter((t) => t.id !== tool.id), tool].slice(
          -MAX_TOOLS
        )
        upsert({
          ...cur,
          recentTools: recent,
          liveStatus: `${tool.name}: ${tool.status}`,
          actionLog: [
            ...cur.actionLog,
            `${tool.status === 'error' ? '✗' : tool.status === 'ok' ? '✓' : '…'} ${tool.name}${tool.path ? ` ${tool.path}` : ''}`
          ].slice(-80)
        })
      } else if (evt.type === 'model') {
        upsert({ ...cur, toolsModel: evt.model, model: evt.model })
      }
    }
    flushThinking(true)
    const done = getBackgroundJob(job.id)
    if (done && done.status === 'running') {
      upsert({
        ...done,
        status: ac.signal.aborted ? 'stopped' : 'done',
        liveStatus: ac.signal.aborted ? 'Stopped' : 'Done — review diff to merge'
      })
    }
    logInfo('Background agent finished', { id: job.id, status: getBackgroundJob(job.id)?.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const aborted = err instanceof Error && err.name === 'AbortError'
    const cur = getBackgroundJob(job.id)
    if (cur) {
      upsert({
        ...cur,
        status: aborted ? 'stopped' : 'failed',
        error: aborted ? 'Stopped' : message,
        liveStatus: aborted ? 'Stopped' : 'Failed'
      })
    }
    logError('Background agent failed', { id: job.id, error: message })
  } finally {
    aborts.delete(job.id)
    void pumpQueue()
  }
}

let currentSender: WebContents | null = null
let currentGetSecret: (key: string) => string | null = () => null

export function configureBackgroundAgents(options: {
  sender: WebContents | null
  getSecret: (key: string) => string | null
}): void {
  currentSender = options.sender
  currentGetSecret = options.getSecret
}

/** Validate specialist id exists when delegating from chat. */
export function resolveDelegateAgentId(workspacePath: string, agentId: string): string | null {
  const agent = findAgent(workspacePath, agentId.trim())
  return agent?.enabled ? agent.id : null
}
