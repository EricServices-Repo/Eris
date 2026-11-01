import { rm } from 'fs/promises'
import { createHash } from 'crypto'
import { ContextMemoryStore } from '../main/services/context-memory-store'
import { workspaceRequest } from '../main/services/workspace-worker-client'
import { ContextMemorySettingsSchema } from '../../src/shared/context-memory'
import type { DevQuestion, DevResult } from '../../src/shared/eris-dev'
import type { ContextPage, MemoryPrompt } from '../../src/shared/context-memory'
import type { DevMemoryMode, DevMemoryTrace } from '../../src/shared/dev-memory-replay'

/** One run-owned namespace. Never reads production chats, settings, or workspace memory. */
export class DevMemoryReplay {
  private store = new ContextMemoryStore()
  private current = ''
  constructor(
    private dir: string,
    private runId: string,
    private mode: DevMemoryMode,
    private episodeSize: number,
    private shareRemote: boolean
  ) {
    this.store.configure(
      ContextMemorySettingsSchema.parse({
        maxThreadMiB: 8,
        warmThreads: 1,
        shareWithRemoteModels: shareRemote,
        foregroundDeadlineMs: 2000
      })
    )
  }
  private episode(index: number) {
    return `${this.runId}:episode:${Math.floor(index / this.episodeSize)}`
  }
  async prepare(
    index: number,
    question: DevQuestion,
    signal: AbortSignal
  ): Promise<{
    threadId: string
    history: NonNullable<DevQuestion['history']>
    prompt: MemoryPrompt
    trace: DevMemoryTrace
  }> {
    const started = performance.now(),
      id = this.episode(index)
    signal.throwIfAborted()
    if (this.current !== id) {
      this.store.clear()
      this.current = id
    }
    let tail = await workspaceRequest({ type: 'chat-get', dir: this.dir, id, page: { limit: 12 } })
    if (!tail) {
      await workspaceRequest({
        type: 'chat-save',
        dir: this.dir,
        thread: {
          id,
          title: 'Memory replay',
          model: 'diagnostic',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      })
      for (const [i, source] of (question.history ?? []).entries())
        await workspaceRequest({
          type: 'chat-append',
          dir: this.dir,
          id,
          message: { ...source, id: `${question.id}:seed:${i}`, createdAt: 1 }
        })
    }
    if (question.memory?.rewindMessages !== undefined) {
      const count = question.memory.rewindMessages
      const prior = await workspaceRequest({
        type: 'chat-get',
        dir: this.dir,
        id,
        page: { before: count, limit: 1 }
      })
      if (!prior || count > (prior.messageCount ?? 0))
        throw new Error('Memory rewind exceeds saved history')
      await workspaceRequest({
        type: 'chat-save',
        dir: this.dir,
        thread: {
          ...prior,
          messages: count ? prior.messages : [],
          messageOffset: count ? count - 1 : 0
        }
      })
    }
    let controls = await workspaceRequest({ type: 'context-controls', dir: this.dir, id })
    if (question.memory?.forgottenSourceIds)
      controls = await workspaceRequest({
        type: 'context-controls',
        dir: this.dir,
        id,
        write: { ...controls, forgotten: question.memory.forgottenSourceIds }
      })
    tail = await workspaceRequest({ type: 'chat-get', dir: this.dir, id, page: { limit: 12 } })
    const records: ContextPage['records'] = []
    let before: number | undefined,
      beforeContentOffset: number | undefined,
      bytes = 0,
      partial = false
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      signal.throwIfAborted()
      const page = await workspaceRequest({
        type: 'context-page',
        dir: this.dir,
        id,
        before,
        beforeContentOffset
      })
      if (!page) break
      records.unshift(...page.records)
      bytes += page.records.reduce(
        (sum, row) => sum + JSON.stringify(row.message).length * 8 + 512,
        0
      )
      before = page.before
      beforeContentOffset = page.beforeContentOffset
      if (page.done) {
        partial = false
        break
      }
      partial = true
      if (bytes >= 8 * 1024 ** 2 || records.length >= 25000) break
    }
    const header = await workspaceRequest({ type: 'context-header', dir: this.dir, id })
    this.store.clear(id)
    const pressureInjected = this.mode === 'pressure' && index % 2 === 1
    this.store.setPressureLimit(pressureInjected ? 0 : Infinity)
    if (header)
      this.store.install(
        id,
        {
          revision: header.revision,
          sourceEpoch: header.sourceEpoch,
          total: header.messageCount,
          records,
          controls,
          partial
        },
        this.store.token(id)
      )
    const selected = await this.store.select(id, question.text, {
      signal,
      policy: this.store.config,
      coveredSourceIds: tail?.messages.map((message) => message.id)
    })
    const expected = question.memory?.expectedSourceIds ?? []
    return {
      threadId: id,
      history: (tail?.messages ?? [])
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content
        })),
      prompt: selected.prompt,
      trace: {
        version: 1,
        episode: id,
        mode: this.mode,
        revision: header?.revision ?? 0,
        controlsRevision: controls.revision ?? 0,
        policyDigest: createHash('sha256').update(JSON.stringify(this.store.config)).digest('hex'),
        expectedSourceIds: expected,
        retrievedSourceIds: selected.prompt.items?.map((item) => item.sourceId) ?? [],
        sentSourceDigests: [],
        missingExpectedSourceIds: [...expected],
        selectionMs: performance.now() - started,
        estimatedBytes: this.store.logicalBytes,
        estimatedTokens: selected.prompt.manifest.estimatedTokens,
        actualModelCalls: 0,
        pressureInjected,
        storeWiped: !pressureInjected && Boolean(header) && !this.store.has(id),
        rawContent: 'in-existing-request-capture-only'
      }
    }
  }
  async commit(index: number, question: DevQuestion, result: DevResult, signal: AbortSignal) {
    signal.throwIfAborted()
    const id = this.episode(index)
    if (!(await workspaceRequest({ type: 'context-header', dir: this.dir, id })))
      await workspaceRequest({
        type: 'chat-save',
        dir: this.dir,
        thread: {
          id,
          title: 'Memory replay',
          model: 'diagnostic',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      })
    await workspaceRequest({
      type: 'chat-append',
      dir: this.dir,
      id,
      message: {
        id: `${question.id}:u`,
        role: 'user',
        content: question.text,
        createdAt: index + 1
      }
    })
    const answer =
      result.responseReason === 'generated' ? result.response : question.memory?.scriptedResponse
    if (answer)
      await workspaceRequest({
        type: 'chat-append',
        dir: this.dir,
        id,
        message: {
          id: `${question.id}:a`,
          role: 'assistant',
          content: answer,
          createdAt: index + 1
        }
      })
  }
  async dispose() {
    this.store.clear()
    await workspaceRequest({ type: 'chat-close', dir: this.dir })
    await rm(this.dir, { recursive: true, force: true })
  }
}
export function finishMemoryTrace(trace: DevMemoryTrace, result: DevResult): DevMemoryTrace {
  const sent = new Set<string>()
  for (const request of result.requests) {
    const dispatch = request.dispatch as
      { items?: Array<{ sourceDigest: string; status: string }> } | undefined
    for (const item of dispatch?.items ?? [])
      if (item.status === 'sent') sent.add(item.sourceDigest)
  }
  return {
    ...trace,
    sentSourceDigests: [...sent],
    actualModelCalls: result.inference?.calls ?? 0,
    missingExpectedSourceIds: trace.expectedSourceIds.filter(
      (id) => !sent.has(createHash('sha256').update(id).digest('hex'))
    )
  }
}
