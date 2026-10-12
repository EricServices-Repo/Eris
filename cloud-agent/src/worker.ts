import { existsSync } from 'fs'
import { JobStore } from './job-store.js'
import { chatCompletion, type ChatMessage } from './llm.js'
import {
  listTree,
  maybeOpenPullRequest,
  prepareWorkspace,
  readText,
  runShell,
  writeText,
  jobWorkspace
} from './workspace.js'
import type { AuthContext } from './auth.js'
import type { CloudJob, CloudJobCreateRequest, CloudJobToolEvent } from './types.js'
import { config } from './config.js'
import { getLocalModelStatus } from './local-model.js'
import {
  buildJobArtifacts,
  saveSeedBaseline,
  snapshotWorkspaceBaseline
} from './artifacts.js'
import {
  clearJobSecrets,
  loadCheckpoint,
  loadJobGithubToken,
  loadJobSeed,
  saveCheckpoint,
  saveJobGithubToken,
  saveJobSeed
} from './job-secrets.js'
import { parseTools, stripTools, SYSTEM_PROMPT } from './tools.js'
import { audit, bumpMetric } from './observe.js'
import { assertCanEnqueue, recordEnqueue } from './entitlements.js'

export class WorkerPool {
  private pumping = false
  private aborts = new Map<string, AbortController>()
  private active = new Set<string>()
  /** Per-owner active count for fair scheduling */
  private ownerActive = new Map<string, number>()

  constructor(private store: JobStore) {
    // Recover any queued jobs after restart
    void this.pump()
  }

  enqueue(req: CloudJobCreateRequest, auth: AuthContext): CloudJob {
    const local = getLocalModelStatus()
    if (!config.llmBase && local.status === 'error') {
      throw new Error(local.error || 'Local cloud model failed to load')
    }

    const gate = assertCanEnqueue(auth, this.store)
    if (!gate.ok) throw new Error(gate.error)

    // Resume path: clone metadata from previous job, reuse workspace/checkpoint
    if (req.resumeFromJobId) {
      return this.enqueueResume(req, auth)
    }

    const job = this.store.create(
      {
        ...req,
        model: req.model || (config.llmBase ? config.llmModel : 'composer')
      },
      { ownerId: auth.owner, plan: auth.plan }
    )

    if (req.files?.length) {
      saveJobSeed(job.id, req.files)
      saveSeedBaseline(
        job.id,
        req.files.map((f) => ({
          path: String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, ''),
          content: String(f.content ?? '')
        }))
      )
    }
    if (req.githubToken?.trim()) {
      saveJobGithubToken(job.id, req.githubToken)
    }

    recordEnqueue(auth)
    bumpMetric('enqueues')
    audit('job_enqueued', {
      jobId: job.id,
      owner: auth.owner,
      plan: auth.plan,
      agentId: job.agentId
    })
    void this.pump()
    return job
  }

  private enqueueResume(req: CloudJobCreateRequest, auth: AuthContext): CloudJob {
    const prev = this.store.get(String(req.resumeFromJobId))
    if (!prev) throw new Error('resumeFromJobId not found')
    if (prev.ownerId && prev.ownerId !== auth.owner && auth.owner !== 'anonymous') {
      throw new Error('Cannot resume another user\'s job')
    }
    if (!prev.resumable && prev.status !== 'failed' && prev.status !== 'stopped') {
      throw new Error('Job is not resumable')
    }

    const gate = assertCanEnqueue(auth, this.store)
    if (!gate.ok) throw new Error(gate.error)

    const job = this.store.create(
      {
        goal: req.goal || prev.goal,
        agentId: req.agentId || prev.agentId,
        model: req.model || prev.model,
        repoUrl: req.repoUrl ?? prev.repoUrl,
        branch: req.branch ?? prev.branch,
        openPr: req.openPr ?? prev.openPr,
        claim: req.claim || `resume: ${prev.claim}`
      },
      { ownerId: auth.owner, plan: auth.plan }
    )

    // Copy secrets / checkpoint from previous job into new id when possible
    const cp = loadCheckpoint(prev.id)
    if (cp) saveCheckpoint(job.id, cp)
    const seed = loadJobSeed(prev.id)
    if (seed) saveJobSeed(job.id, seed)
    const token = loadJobGithubToken(prev.id)
    if (token) saveJobGithubToken(job.id, token)
    if (req.githubToken?.trim()) saveJobGithubToken(job.id, req.githubToken)
    if (req.files?.length) {
      saveJobSeed(job.id, req.files)
      saveSeedBaseline(
        job.id,
        req.files.map((f) => ({
          path: String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, ''),
          content: String(f.content ?? '')
        }))
      )
    }

    this.store.patch(job.id, (j) => ({
      ...j,
      resumable: true,
      step: cp?.step || 0,
      liveStatus: 'Queued (resume)',
      filesTouched: [...prev.filesTouched],
      thinkingTail: prev.thinkingTail
    }))

    recordEnqueue(auth)
    bumpMetric('enqueues')
    audit('job_resume_enqueued', {
      jobId: job.id,
      from: prev.id,
      owner: auth.owner
    })
    void this.pump()
    return this.store.get(job.id)!
  }

  stop(id: string, auth?: AuthContext): boolean {
    const job = this.store.get(id)
    if (!job) return false
    if (auth && job.ownerId && job.ownerId !== auth.owner && auth.owner !== 'anonymous') {
      return false
    }
    const ac = this.aborts.get(id)
    if (ac) {
      ac.abort()
      return true
    }
    if (job.status === 'queued') {
      this.store.setStatus(id, 'stopped', {
        liveStatus: 'Stopped',
        error: 'Cancelled before start',
        resumable: true
      })
      bumpMetric('jobsStopped')
      audit('job_stopped', { jobId: id })
      return true
    }
    return false
  }

  /**
   * Force-stop queued + running jobs.
   * - `owner` set: only that owner's jobs (user clear)
   * - omit / null owner: every active job (admin kill-all)
   */
  stopAll(options?: { owner?: string | null }): { stopped: string[]; count: number } {
    const ownerFilter =
      options && options.owner != null && options.owner !== '' ? options.owner : null
    const ids = new Set<string>()

    for (const job of this.store.list(500)) {
      if (job.status !== 'queued' && job.status !== 'running') continue
      if (ownerFilter && (job.ownerId || 'anonymous') !== ownerFilter) continue
      ids.add(job.id)
    }
    if (!ownerFilter) {
      for (const id of this.aborts.keys()) ids.add(id)
    }

    const stopped: string[] = []
    for (const id of ids) {
      if (this.stop(id)) stopped.push(id)
    }

    audit('jobs_stop_all', {
      owner: ownerFilter || '*',
      count: stopped.length
    })
    return { stopped, count: stopped.length }
  }

  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const slots = config.maxParallel - this.active.size
        if (slots <= 0) break
        const queued = this.store
          .list(500)
          .filter((j) => j.status === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        if (queued.length === 0) break

        // Fairness: prefer owners with fewer active jobs
        const ranked = [...queued].sort((a, b) => {
          const ao = this.ownerActive.get(a.ownerId || 'anonymous') || 0
          const bo = this.ownerActive.get(b.ownerId || 'anonymous') || 0
          if (ao !== bo) return ao - bo
          return a.createdAt.localeCompare(b.createdAt)
        })

        const batch: CloudJob[] = []
        for (const job of ranked) {
          if (batch.length >= slots) break
          const owner = job.ownerId || 'anonymous'
          const maxForOwner =
            job.plan === 'pro' ? config.maxConcurrentPro : config.maxConcurrentFree
          const activeForOwner = this.ownerActive.get(owner) || 0
          // Count already-running in store too
          const storeRunning = this.store
            .list(200)
            .filter(
              (j) =>
                j.ownerId === owner &&
                j.status === 'running' &&
                !batch.some((b) => b.id === j.id)
            ).length
          if (activeForOwner + storeRunning >= maxForOwner) continue
          batch.push(job)
        }
        if (batch.length === 0) break

        for (const job of batch) {
          this.store.setStatus(job.id, 'running', { liveStatus: 'Starting…' })
          this.active.add(job.id)
          const owner = job.ownerId || 'anonymous'
          this.ownerActive.set(owner, (this.ownerActive.get(owner) || 0) + 1)
          void this.runJob(job.id).finally(() => {
            this.active.delete(job.id)
            this.ownerActive.set(
              owner,
              Math.max(0, (this.ownerActive.get(owner) || 1) - 1)
            )
            void this.pump()
          })
        }
        break
      }
    } finally {
      this.pumping = false
    }
  }

  private async runJob(id: string): Promise<void> {
    const ac = new AbortController()
    this.aborts.set(id, ac)
    const job = this.store.get(id)
    if (!job) {
      this.aborts.delete(id)
      return
    }

    try {
      const checkpoint = loadCheckpoint(id)
      const seed = loadJobSeed(id)
      const githubToken = loadJobGithubToken(id)
      const workspaceExists = existsSync(jobWorkspace(id))
      const reuse = Boolean(checkpoint?.workspaceReady && workspaceExists)

      this.store.patch(id, (j) => ({
        ...j,
        liveStatus: reuse ? 'Resuming workspace…' : 'Preparing workspace…'
      }))

      const workspace = await prepareWorkspace({
        jobId: id,
        repoUrl: job.repoUrl,
        branch: job.branch,
        files: reuse ? undefined : seed,
        githubToken,
        reuse
      })

      // For git clones without seed overlay, snapshot touched-empty baseline later on first writes
      if (!reuse && seed?.length) {
        saveSeedBaseline(
          id,
          seed.map((f) => ({
            path: String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, ''),
            content: String(f.content ?? '')
          }))
        )
      }

      let messages: ChatMessage[]
      let startStep = 1
      if (checkpoint?.messages?.length) {
        messages = checkpoint.messages
        startStep = Math.max(1, (checkpoint.step || 0) + 1)
        this.store.patch(id, (j) => ({
          ...j,
          liveStatus: `Resuming · step ${startStep}`,
          step: checkpoint.step
        }))
      } else {
        messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Agent: ${job.agentName} (${job.agentId})\nGoal:\n${job.goal}`
          }
        ]
      }

      const maxSteps = config.maxSteps
      for (let step = startStep; step <= maxSteps; step++) {
        if (ac.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
        this.store.patch(id, (j) => ({
          ...j,
          step,
          liveStatus: `${job.agentName} · step ${step}`
        }))

        const assistant = await chatCompletion(messages, {
          model: job.model,
          signal: ac.signal
        })
        messages.push({ role: 'assistant', content: assistant })
        this.store.patch(id, (j) => ({
          ...j,
          thinkingTail: (j.thinkingTail + `\n${assistant}`).slice(-4000)
        }))

        saveCheckpoint(id, { step, messages, workspaceReady: true })

        const tools = parseTools(assistant)
        if (tools.length === 0) {
          const answer = stripTools(assistant) || assistant
          const current = this.store.get(id)!
          let prUrl: string | null = null
          if (job.openPr && job.repoUrl && githubToken) {
            this.store.patch(id, (j) => ({ ...j, liveStatus: 'Opening pull request…' }))
            const prResult = await maybeOpenPullRequest({
              workspace,
              repoUrl: job.repoUrl,
              baseBranch: job.branch || null,
              githubToken,
              jobId: id,
              goal: job.goal,
              filesTouched: current.filesTouched
            })
            if (prResult?.startsWith('http')) prUrl = prResult
            else if (prResult) {
              // keep note in answer
            }
          }
          const pack = buildJobArtifacts(id, current.filesTouched || [])
          this.store.setStatus(id, 'done', {
            answer: prUrl
              ? `${answer}\n\nPull request: ${prUrl}`
              : answer,
            liveStatus:
              pack.files.length > 0
                ? `Done · ${pack.files.length} file${pack.files.length === 1 ? '' : 's'} ready to apply`
                : 'Done',
            hasArtifacts: pack.files.length > 0,
            artifactCount: pack.files.length,
            artifactsTruncated: pack.truncated,
            truncatedReasons: pack.truncatedReasons,
            prUrl,
            resumable: false
          })
          bumpMetric('jobsDone')
          audit('job_done', { jobId: id, artifacts: pack.files.length, prUrl })
          clearJobSecrets(id)
          return
        }

        const results: string[] = []
        for (let i = 0; i < tools.length; i++) {
          const call = tools[i]!
          const toolId = `t${step}_${i}`
          const path =
            typeof call.args.path === 'string'
              ? call.args.path
              : typeof call.args.command === 'string'
                ? String(call.args.command).slice(0, 80)
                : undefined
          const running: CloudJobToolEvent = {
            id: toolId,
            name: call.name,
            path,
            status: 'running',
            detail: 'Running…',
            at: new Date().toISOString()
          }
          this.store.patch(id, (j) => ({
            ...j,
            recentTools: [...j.recentTools.filter((t) => t.id !== toolId), running].slice(-40),
            liveStatus: `${call.name}: running`
          }))

          let ok = true
          let detail = ''
          let touched: string | undefined
          try {
            if (call.name === 'tree') {
              detail = listTree(
                workspace,
                typeof call.args.path === 'string' ? call.args.path : '.',
                typeof call.args.maxDepth === 'number' ? call.args.maxDepth : 3
              )
            } else if (call.name === 'read_file') {
              const p = String(call.args.path || '')
              detail = readText(workspace, p)
              touched = p
            } else if (call.name === 'write_file') {
              const p = String(call.args.path || '')
              // Capture before content for artifact baseline if not seeded
              try {
                snapshotWorkspaceBaseline(id, [p])
              } catch {
                // ignore
              }
              const content = String(call.args.content ?? '')
              touched = writeText(workspace, p, content)
              detail = `Wrote ${touched} (${Buffer.byteLength(content, 'utf8')} bytes)`
            } else if (call.name === 'run') {
              const command = String(call.args.command || '')
              const r = await runShell(workspace, command, ac.signal)
              ok = r.ok
              detail = r.detail
            } else {
              ok = false
              detail = `Unknown tool: ${call.name}`
            }
          } catch (err) {
            ok = false
            detail = err instanceof Error ? err.message : String(err)
          }

          const done: CloudJobToolEvent = {
            ...running,
            status: ok ? 'ok' : 'error',
            detail: detail.slice(0, 2000),
            at: new Date().toISOString()
          }
          this.store.patch(id, (j) => ({
            ...j,
            recentTools: [...j.recentTools.filter((t) => t.id !== toolId), done].slice(-40),
            filesTouched: touched
              ? [...new Set([...j.filesTouched, touched])]
              : j.filesTouched,
            liveStatus: `${call.name}: ${ok ? 'ok' : 'error'}`
          }))
          results.push(`TOOL_RESULT ${call.name}:\n${detail.slice(0, 8000)}`)
        }

        messages.push({
          role: 'user',
          content:
            results.join('\n\n') +
            '\n\nContinue with tools if needed, or reply DONE with a short summary.'
        })
        saveCheckpoint(id, { step, messages, workspaceReady: true })
      }

      {
        const current = this.store.get(id)
        const pack = buildJobArtifacts(id, current?.filesTouched || [])
        this.store.setStatus(id, 'failed', {
          error: 'Step limit reached',
          liveStatus: 'Failed',
          answer: current?.answer || 'Stopped at step limit',
          hasArtifacts: pack.files.length > 0,
          artifactCount: pack.files.length,
          artifactsTruncated: pack.truncated,
          truncatedReasons: pack.truncatedReasons,
          resumable: true
        })
        bumpMetric('jobsFailed')
        audit('job_failed', { jobId: id, error: 'step_limit' })
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      const current = this.store.get(id)
      const pack = buildJobArtifacts(id, current?.filesTouched || [])
      this.store.setStatus(id, aborted ? 'stopped' : 'failed', {
        error: aborted ? 'Stopped' : err instanceof Error ? err.message : String(err),
        liveStatus: aborted ? 'Stopped' : 'Failed',
        hasArtifacts: pack.files.length > 0,
        artifactCount: pack.files.length,
        artifactsTruncated: pack.truncated,
        truncatedReasons: pack.truncatedReasons,
        resumable: true
      })
      if (aborted) bumpMetric('jobsStopped')
      else bumpMetric('jobsFailed')
      audit(aborted ? 'job_stopped' : 'job_failed', {
        jobId: id,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      this.aborts.delete(id)
    }
  }
}
