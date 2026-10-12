import { JobStore } from './job-store.js'
import { chatCompletion, type ChatMessage } from './llm.js'
import {
  listTree,
  prepareWorkspace,
  readText,
  runShell,
  writeText
} from './workspace.js'
import type { CloudJob, CloudJobCreateRequest, CloudJobToolEvent } from './types.js'
import { config } from './config.js'
import { getLocalModelStatus } from './local-model.js'

const TOOL_RE = /<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/gi

const SYSTEM = `You are an Eris Cloud Agent working in an isolated workspace.
Use tools by emitting:

<<<TOOL>>>
{"name":"tree","path":"."}
<<<END>>>

Tools:
- tree — { "name":"tree", "path":".", "maxDepth":3 }
- read_file — { "name":"read_file", "path":"file.ts" }
- write_file — { "name":"write_file", "path":"file.ts", "content":"..." }
- run — { "name":"run", "command":"npm test" }

Rules:
- Prefer concrete file edits over long plans.
- After TOOL_RESULT, keep going until the goal is done.
- When finished, reply with a short DONE summary and no tools.
- Paths are relative to the workspace root.`

function parseTools(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = []
  TOOL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOOL_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]!) as Record<string, unknown>
      const name = String(obj.name || '')
      if (!name) continue
      const args = { ...obj }
      delete args.name
      out.push({ name, args })
    } catch {
      // ignore bad block
    }
  }
  return out
}

function stripTools(text: string): string {
  return text.replace(TOOL_RE, '').trim()
}

/** Files attached at create time (not persisted in job JSON for size). */
export const pendingFiles = new Map<string, CloudJobCreateRequest['files']>()

export class WorkerPool {
  private pumping = false
  private aborts = new Map<string, AbortController>()
  private active = new Set<string>()

  constructor(private store: JobStore) {}

  enqueue(req: CloudJobCreateRequest): CloudJob {
    const local = getLocalModelStatus()
    if (!config.llmBase && local.status === 'error') {
      throw new Error(local.error || 'Local cloud model failed to load')
    }
    const job = this.store.create({
      ...req,
      model: req.model || (config.llmBase ? config.llmModel : 'composer')
    })
    if (req.files?.length) pendingFiles.set(job.id, req.files)
    void this.pump()
    return job
  }

  stop(id: string): boolean {
    const ac = this.aborts.get(id)
    if (ac) {
      ac.abort()
      return true
    }
    const job = this.store.get(id)
    if (job?.status === 'queued') {
      this.store.setStatus(id, 'stopped', {
        liveStatus: 'Stopped',
        error: 'Cancelled before start'
      })
      pendingFiles.delete(id)
      return true
    }
    return false
  }

  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const slots = config.maxParallel - this.active.size
        if (slots <= 0) break
        const queued = this.store
          .list(200)
          .filter((j) => j.status === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        if (queued.length === 0) break
        const batch = queued.slice(0, slots)
        for (const job of batch) {
          this.store.setStatus(job.id, 'running', { liveStatus: 'Starting…' })
          this.active.add(job.id)
          void this.runJob(job.id).finally(() => {
            this.active.delete(job.id)
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
      this.store.patch(id, (j) => ({ ...j, liveStatus: 'Preparing workspace…' }))
      const files = pendingFiles.get(id)
      pendingFiles.delete(id)
      const workspace = await prepareWorkspace({
        jobId: id,
        repoUrl: job.repoUrl,
        branch: job.branch,
        files
      })

      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Agent: ${job.agentName} (${job.agentId})\nGoal:\n${job.goal}`
        }
      ]

      for (let step = 1; step <= 24; step++) {
        if (ac.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
        this.store.patch(id, (j) => ({
          ...j,
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

        const tools = parseTools(assistant)
        if (tools.length === 0) {
          const answer = stripTools(assistant) || assistant
          this.store.setStatus(id, 'done', {
            answer,
            liveStatus: 'Done'
          })
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
      }

      this.store.setStatus(id, 'failed', {
        error: 'Step limit reached',
        liveStatus: 'Failed',
        answer: this.store.get(id)?.answer || 'Stopped at step limit'
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      this.store.setStatus(id, aborted ? 'stopped' : 'failed', {
        error: aborted ? 'Stopped' : err instanceof Error ? err.message : String(err),
        liveStatus: aborted ? 'Stopped' : 'Failed'
      })
    } finally {
      this.aborts.delete(id)
    }
  }
}
