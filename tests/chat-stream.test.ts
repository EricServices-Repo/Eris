/* eslint-disable require-yield -- fake runners only need to exercise approveCommand */
import { randomUUID } from 'crypto'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatDatabase } from '../electron/main/services/chat-database'
import { ipcMain } from 'electron'
import type { TurnPlan } from '../src/shared/settings-schema'

type RunnerOptions = {
  conversationMemory?: import('../src/shared/context-memory').MemoryPrompt
  messages: Array<{ role: string; content: string }>
  workspacePath: string
  turnPlan: TurnPlan
  signal: AbortSignal
  approveCommand: (kind: 'run' | 'push', command: string) => Promise<boolean>
}
type RunnerEvent = Record<string, unknown> & { type: string }

const runner = vi.hoisted(() => ({
  script: async function* (_opts: RunnerOptions): AsyncGenerator<RunnerEvent> {}
}))

vi.mock('../electron/main/services/agent-runner', () => ({
  runAgentWithWorkspaceTools: (opts: RunnerOptions) => runner.script(opts)
}))
vi.mock('../electron/main/services/task-resolver', () => ({
  resolveTaskIntent: async (input: { fallback: string }) => input.fallback,
  resolveTaskDecision: async (input: { fallback: string }) => ({
    intent: input.fallback,
    initialIntent: input.fallback,
    source: 'bypass',
    rule: 'test',
    durationMs: 0
  })
}))
vi.mock('../electron/main/services/task-outcome', () => ({
  reviewTaskOutcome: vi.fn(async () => ({ verdict: 'supported', reason: 'test verdict' }))
}))
vi.mock('../electron/main/services/builtin-model', async () => {
  const actual = await vi.importActual<typeof import('../electron/main/services/builtin-model')>(
    '../electron/main/services/builtin-model'
  )
  return {
    ...actual,
    isExactBuiltinReady: () => true,
    resolveExactBuiltinRef: (model: string) => model
  }
})
vi.mock('../electron/main/services/diagnostics', () => ({ setDiagnosticsPaused: () => undefined }))
vi.mock('../electron/main/ipc/shared', () => ({
  getSecret: () => '',
  abortAllCompletes: () => undefined
}))

const { registerChatStreamIpc } = await import('../electron/main/ipc/chat-stream')
const { appState } = await import('../electron/main/app-state')
const { workspaceAllowedCommands } = await import('../electron/main/services/workspace-trust')
const { getResolvedSettings } = await import('../electron/main/services/settings')

type Handler = (event: unknown, ...args: unknown[]) => unknown
let handlers: Record<string, Handler> = {}
let sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
/** Decision the fake renderer answers approval prompts with (null = never answer) */
let reply: 'allow' | 'always' | 'deny' | null = 'allow'

const sender = {
  isDestroyed: () => false,
  send: (channel: string, payload: Record<string, unknown>) => {
    sent.push({ channel, payload })
    if (channel === 'chat:approval-request' && reply) {
      const decision = reply
      queueMicrotask(() => {
        void handlers['chat:approvalRespond']!(null, payload.approvalId, decision)
      })
    }
  }
}

const plan: TurnPlan = {
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'full',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'manual'
}

function stream(prompt?: Record<string, unknown>, requestId = randomUUID()) {
  return handlers['chat:stream']!(
    { sender },
    {
      requestId,
      model: 'builtin:composer-lite',
      mode: 'agent',
      turnPlan: plan,
      ...(prompt
        ? {
            prompt: {
              mode: 'agent',
              agentId: 'composer',
              skillIds: [],
              attachments: [],
              history: [],
              ...prompt
            }
          }
        : { messages: [{ role: 'user', content: 'do it' }] })
    }
  )
}

const channels = () => sent.map((s) => s.channel)

beforeEach(() => {
  handlers = {}
  sent = []
  reply = 'allow'
  vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: Handler) => {
    handlers[channel] = fn
  }) as never)
  registerChatStreamIpc()
  appState.currentWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'eris-chat-')))
})

describe('chat:stream command approval', () => {
  it('shows applied files when cancellation interrupts a later approval', async () => {
    reply = null
    const requestId = randomUUID()
    runner.script = async function* (options) {
      yield { type: 'progress', step: 1, filesTouched: ['booking.php'], actionLog: ['Wrote booking.php'] }
      const pending = options.approveCommand('run', 'npm install package')
      queueMicrotask(() => void handlers['chat:stop']!({ sender }, requestId))
      await pending
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    expect(await stream(undefined, requestId)).toBe(false)
    expect(sent.filter(event => event.channel === 'chat:answer').at(-1)?.payload.chunk).toContain('Applied changes: booking.php')
    expect(sent.find(event => event.channel === 'chat:done')?.payload.aborted).toBe(true)
  })
  it('runs safe commands without prompting', async () => {
    const results: boolean[] = []
    runner.script = async function* (opts) {
      results.push(await opts.approveCommand('run', 'git status'))
      yield { type: 'answer', text: 'ok' }
    }
    expect(await stream()).toBe(true)
    expect(results).toEqual([true])
    expect(channels()).not.toContain('chat:approval-request')
    expect(channels()).toContain('chat:done')
  })

  it('blocks a denied command', async () => {
    reply = 'deny'
    const results: boolean[] = []
    runner.script = async function* (opts) {
      results.push(await opts.approveCommand('run', 'rm -rf build'))
    }
    await stream()
    expect(results).toEqual([false])
    expect(channels()).toContain('chat:approval-resolved')
  })

  it('"always" remembers the command for this workspace only', async () => {
    reply = 'always'
    const results: boolean[] = []
    runner.script = async function* (opts) {
      results.push(await opts.approveCommand('run', 'make  deploy'))
      reply = null
      results.push(await opts.approveCommand('run', 'make deploy'))
    }
    await stream()
    expect(results).toEqual([true, true])
    expect(channels().filter((c) => c === 'chat:approval-request')).toHaveLength(1)
    expect(workspaceAllowedCommands(appState.currentWorkspace)).toEqual(['make deploy'])
    expect(getResolvedSettings(null).agent.allowedCommands).not.toContain('make deploy')
  })

  it('chat:stop denies a pending approval and ends the stream as aborted', async () => {
    reply = null
    const requestId = randomUUID()
    const results: boolean[] = []
    runner.script = async function* (opts) {
      const pending = opts.approveCommand('run', 'rm -rf build')
      queueMicrotask(() => void handlers['chat:stop']!({ sender }, requestId))
      results.push(await pending)
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    expect(await stream(undefined, requestId)).toBe(false)
    expect(results).toEqual([false])
    const done = sent.find((s) => s.channel === 'chat:done')
    expect(done?.payload.aborted).toBe(true)
  })
})

describe('main-process task authority', () => {
  const databases: ChatDatabase[]=[]
  afterEach(()=>databases.splice(0).forEach(db=>db.close()))
  it('publishes and replays the one canonical completed reply without another append (#451)', async () => {
    const chats=await import('../electron/main/services/chats')
    const dir=mkdtempSync(join(tmpdir(),'eris-terminal-owner-'))
    let db=new ChatDatabase(dir)
    databases.push(db)
    const thread=db.save({id:randomUUID(),title:'Terminal',model:'builtin:composer-lite',messages:[],createdAt:1,updatedAt:1})
    vi.spyOn(chats,'getChat').mockImplementation(async (_root,id,page)=>db.get(id,page))
    const append=vi.spyOn(chats,'appendChatMessage').mockImplementation(async (_root,id,message,model)=>db.append(id,message,model))
    const memory=await import('../electron/main/services/context-memory')
    vi.spyOn(memory,'conversationContext').mockRejectedValue(Error('cache unavailable'))
    let executions=0
    runner.script=async function* () { executions++; yield {type:'answer',text:'Completed the requested inspection.'} }
    const requestId=randomUUID(), prompt={text:'Review the booking flow',threadId:thread.id}
    expect(await stream(prompt,requestId)).toBe(true)
    const canonical=sent.find(event=>event.channel==='chat:done')?.payload.reply
    expect(canonical).toMatchObject({id:`${requestId}:assistant`,contextResult:{terminal:'done',completion:{execution:'completed',persistence:'saved'}}})
    db.close(); databases.splice(databases.indexOf(db),1)
    db=new ChatDatabase(dir); databases.push(db)
    expect(db.get(thread.id)?.messages.find(message=>message.id===`${requestId}:assistant`)).toEqual(canonical)
    await stream(prompt,requestId)
    expect(executions).toBe(1)
    expect(append.mock.calls.filter(call=>call[2].role==='assistant')).toHaveLength(1)
    expect(sent.filter(event=>event.channel==='chat:done').at(-1)?.payload.reply).toEqual(canonical)
  })
  it('persists partial text and applied files before an error and reloads one reply (#449)', async () => {
    const chats=await import('../electron/main/services/chats')
    const dir=mkdtempSync(join(tmpdir(),'eris-partial-reload-'))
    let db=new ChatDatabase(dir)
    databases.push(db)
    const thread=db.save({id:randomUUID(),title:'Partial',model:'builtin:composer-lite',messages:[],createdAt:1,updatedAt:1})
    vi.spyOn(chats,'getChat').mockImplementation(async (_root,id,page)=>db.get(id,page))
    vi.spyOn(chats,'appendChatMessage').mockImplementation(async (_root,id,message,model)=>db.append(id,message,model))
    const memory=await import('../electron/main/services/context-memory')
    vi.spyOn(memory,'conversationContext').mockRejectedValue(Error('cache unavailable'))
    const requestId=randomUUID()
    runner.script=async function* () {
      yield {type:'answer',text:'Implemented the '}
      yield {type:'answer',text:'booking validation.'}
      yield {type:'progress',step:1,filesTouched:['booking.ts'],actionLog:['Edited booking.ts']}
      throw Error('Synthetic provider disconnect')
    }
    expect(await stream({text:'Fix booking validation',threadId:thread.id},requestId)).toBe(false)
    const failure=sent.find(event=>event.channel==='chat:error')?.payload
    expect(failure?.error).toBe('Synthetic provider disconnect')
    const snapshot=failure?.reply as import('../src/shared/settings-schema').ChatMessage
    expect(snapshot.content).toContain('Implemented the booking validation.')
    expect(snapshot.content).toContain('Partial response')
    expect(snapshot.contextResult).toMatchObject({terminal:'failed',changedFiles:['booking.ts'],
      completion:{execution:'incomplete',persistence:'saved'}})
    db.close()
    databases.splice(databases.indexOf(db),1)
    db=new ChatDatabase(dir)
    databases.push(db)
    const reloaded=db.get(thread.id)
    const replies=reloaded?.messages.filter(message=>message.id===`${requestId}:assistant`)
    expect(replies).toHaveLength(1)
    expect(replies?.[0]).toEqual(snapshot)
    expect(channels()).not.toContain('chat:done')
  })
  it('exports a visible non-durable snapshot when partial-reply persistence fails (#449)', async () => {
    const chats=await import('../electron/main/services/chats')
    const db=new ChatDatabase(mkdtempSync(join(tmpdir(),'eris-partial-storage-')))
    databases.push(db)
    const thread=db.save({id:randomUUID(),title:'Partial',model:'builtin:composer-lite',messages:[],createdAt:1,updatedAt:1})
    vi.spyOn(chats,'getChat').mockImplementation(async (_root,id,page)=>db.get(id,page))
    vi.spyOn(chats,'appendChatMessage').mockImplementation(async (_root,id,message,model) => {
      if(message.role==='assistant') throw Error('disk full')
      return db.append(id,message,model)
    })
    const memory=await import('../electron/main/services/context-memory')
    vi.spyOn(memory,'conversationContext').mockRejectedValue(Error('cache unavailable'))
    runner.script=async function* () { yield {type:'answer',text:'Useful partial code'}; throw Error('disconnect') }
    expect(await stream({text:'Fix booking',threadId:thread.id})).toBe(false)
    const failure=sent.find(event=>event.channel==='chat:error')?.payload
    expect(failure?.error).toContain('could not be saved')
    const snapshot=failure?.reply as import('../src/shared/settings-schema').ChatMessage
    expect(snapshot.content).toContain('Useful partial code')
    expect(snapshot.contextResult?.completion?.persistence).toBe('failed')
    const reloaded=db.get(thread.id)
    expect(reloaded?.messages.filter(message=>message.role==='assistant')).toHaveLength(0)
  })
  it('reports applied changes as incomplete when final task persistence fails', async () => {
    const store = await import('../electron/main/services/task-store')
    const actual = store.saveTask
    let saves = 0
    vi.spyOn(store, 'saveTask').mockImplementation(task => {
      if (++saves === 2) throw new Error('synthetic task storage fault')
      actual(task)
    })
    const requestId = randomUUID()
    runner.script = async function* () {
      yield { type: 'progress', step: 1, actionLog: ['Edited booking.ts'], filesTouched: ['booking.ts'] }
      yield { type: 'answer', text: 'Implemented booking validation.' }
    }
    expect(await stream(undefined, requestId)).toBe(true)
    const { getChatJob } = await import('../electron/main/services/chat-job-controller')
    expect(getChatJob(requestId)?.status).toBe('incomplete')
    const answer = sent.filter(e => e.channel === 'chat:answer').at(-1)?.payload.chunk
    expect(answer).toContain('Implemented booking validation.')
    expect(answer).toContain('Task result could not be saved')
    expect(answer).toContain('booking.ts')
    expect(sent.find(e => e.channel === 'chat:done')?.payload.incomplete).toBe(true)
  })
  it('admits a corrected request after stop without reviving the earlier task', async () => {
    const originalId = randomUUID()
    const correctedId = randomUUID()
    const plans: TurnPlan[] = []
    reply = null
    runner.script = async function* (options) {
      plans.push(options.turnPlan)
      const pending = options.approveCommand('run', 'npm install legacy-package')
      queueMicrotask(() => void handlers['chat:stop']!({ sender }, originalId))
      expect(await pending).toBe(false)
      throw Object.assign(new Error('Stopped for correction'), { name: 'AbortError' })
    }
    expect(await stream({ text: 'Add booking validation and install legacy-package' }, originalId)).toBe(false)
    runner.script = async function* (options) {
      plans.push(options.turnPlan)
      expect(options.messages.at(-1)?.content).toContain('Do not install any dependencies')
      yield { type: 'answer', text: 'I will use the existing dependencies.' }
    }
    expect(await stream({ text: 'Add booking validation. Do not install any dependencies.' }, correctedId)).toBe(true)
    expect(plans[1]?.task?.originalText).toBe('Add booking validation. Do not install any dependencies.')
    const { getChatJob } = await import('../electron/main/services/chat-job-controller')
    expect(getChatJob(originalId)?.status).toBe('stopped')
    expect(getChatJob(correctedId)?.status).toBe('done')
    expect(sent.filter(event => event.channel === 'chat:done' && event.payload.requestId === originalId)).toHaveLength(1)
  })
  it('ignores a renderer editing plan when the request is a review', async () => {
    let actual: TurnPlan | undefined
    runner.script = async function* (options) {
      actual = options.turnPlan
      yield { type: 'answer', text: 'Findings from the selected project.' }
    }
    await stream({ text: 'Review the code, improve it for the Airbnb website' })
    expect(actual?.intent).toBe('review')
    expect(actual?.task?.authority.edit).toBe(false)
    expect(actual?.task?.originalText).toContain('Airbnb')
  })
  it('executes one request ID once', async () => {
    let calls = 0
    runner.script = async function* () {
      calls++
      yield { type: 'answer', text: 'Answer' }
    }
    const requestId = randomUUID()
    await stream(undefined, requestId)
    await stream(undefined, requestId)
    expect(calls).toBe(1)
  })
  it('keeps the execution workspace bound after a workspace switch', async () => {
    const original = appState.currentWorkspace
    runner.script = async function* (options) {
      appState.currentWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'eris-other-')))
      expect(options.workspacePath).toBe(original)
      expect(options.turnPlan.task?.scope.workspaceRoot).toBe(original)
      yield { type: 'answer', text: 'Bound to original workspace' }
    }
    await stream()
    const { getLatestChatJob } = await import('../electron/main/services/chat-job-controller')
    expect(getLatestChatJob(original)?.workspacePath).toBe(original)
  })
  it('persists incomplete outcomes without relabeling them done', async () => {
    const original = appState.currentWorkspace
    runner.script = async function* () {
      yield { type: 'progress', step: 1, filesTouched: [], actionLog: [], incomplete: true }
      yield { type: 'answer', text: 'Incomplete: source evidence missing.' }
    }
    await stream()
    const { getLatestChatJob } = await import('../electron/main/services/chat-job-controller')
    expect(getLatestChatJob(original)?.status).toBe('incomplete')
  })
})


/** A thread-backed edit turn whose outcome is reviewed with the given verdict. */
async function reviewedTurn(verdict: Record<string, unknown>) {
  const chats = await import('../electron/main/services/chats')
  const { reviewTaskOutcome } = await import('../electron/main/services/task-outcome')
  vi.mocked(reviewTaskOutcome).mockClear()
  vi.mocked(reviewTaskOutcome).mockResolvedValueOnce(verdict as never)
  const requestId = randomUUID(), threadId = randomUUID()
  const thread = { id: threadId, title: 'Booking', model: 'builtin:composer-lite', messages: [], createdAt: 1, updatedAt: 1 }
  vi.spyOn(chats, 'getChat').mockResolvedValue(thread)
  vi.spyOn(chats, 'appendChatMessage').mockImplementation(async (_root, _id, message) => ({ ...thread, messages: [message] }))
  const memory = await import('../electron/main/services/context-memory')
  vi.spyOn(memory, 'conversationContext').mockRejectedValue(Error('cache unavailable'))
  runner.script = async function* () {
    yield { type: 'progress', step: 1, actionLog: ['Changed booking.ts'], filesTouched: ['booking.ts'] }
    yield { type: 'answer', text: 'Implemented booking validation.' }
  }
  await stream({ text: 'Implement booking validation', threadId }, requestId)
  expect(reviewTaskOutcome).toHaveBeenCalledTimes(1)
  const saved = vi.mocked(chats.appendChatMessage).mock.calls.find(call => call[2].role === 'assistant')![2]
  const done = sent.find((item) => item.channel === 'chat:done' && item.payload.requestId === requestId)
  return { saved, incomplete: done?.payload.incomplete }
}

describe('canonical RAM history at the production chat IPC boundary', () => {
  it('persists execution and verification evidence separately from evaluator timeout', async () => {
    const chats = await import('../electron/main/services/chats')
    const { reviewTaskOutcome } = await import('../electron/main/services/task-outcome')
    vi.mocked(reviewTaskOutcome).mockResolvedValueOnce({
      verdict: 'unresolved', failure: 'timeout', reason: 'Semantic assessment timed out.'
    })
    const requestId = randomUUID(), threadId = randomUUID()
    const thread = { id: threadId, title: 'Booking', model: 'builtin:composer-lite', messages: [], createdAt: 1, updatedAt: 1 }
    vi.spyOn(chats, 'getChat').mockResolvedValue(thread)
    vi.spyOn(chats, 'appendChatMessage').mockImplementation(async (_root, _id, message) => ({ ...thread, messages: [message] }))
    const memory = await import('../electron/main/services/context-memory')
    vi.spyOn(memory, 'conversationContext').mockRejectedValue(Error('cache unavailable'))
    runner.script = async function* () {
      yield { type: 'progress', step: 1, actionLog: ['Changed booking.ts'], filesTouched: ['booking.ts'] }
      yield { type: 'tool', tool: { id: 'v', name: 'verify', status: 'ok', detail: 'Fixture checks passed' } }
      yield { type: 'answer', text: 'Implemented and tested booking validation.' }
    }
    expect(await stream({ text: 'Implement booking validation', threadId }, requestId)).toBe(true)
    const saved = vi.mocked(chats.appendChatMessage).mock.calls.find(call => call[2].role === 'assistant')![2]
    // A reviewer that timed out is recorded but does not make finished work incomplete (#500).
    expect(saved.contextResult).toMatchObject({
      terminal: 'done', changedFiles: ['booking.ts'], completion: {
        execution: 'completed', verification: 'passed', persistence: 'saved',
        assessment: { status: 'unresolved', failure: 'timeout' }
      }
    })
    expect(saved.content).toBe('Implemented and tested booking validation.')
    const done = sent.find((item) => item.channel === 'chat:done' && item.payload.requestId === requestId)
    expect(done?.payload.incomplete).toBe(false)
  })
  it('marks a disagreeing review incomplete without writing the verdict into the answer (#500, #502)', async () => {
    const chats = await import('../electron/main/services/chats')
    const { reviewTaskOutcome } = await import('../electron/main/services/task-outcome')
    vi.mocked(reviewTaskOutcome).mockResolvedValueOnce({
      verdict: 'partial', reason: 'The answer does not mention the date range check.'
    })
    const requestId = randomUUID(), threadId = randomUUID()
    const thread = { id: threadId, title: 'Booking', model: 'builtin:composer-lite', messages: [], createdAt: 1, updatedAt: 1 }
    vi.spyOn(chats, 'getChat').mockResolvedValue(thread)
    vi.spyOn(chats, 'appendChatMessage').mockImplementation(async (_root, _id, message) => ({ ...thread, messages: [message] }))
    const memory = await import('../electron/main/services/context-memory')
    vi.spyOn(memory, 'conversationContext').mockRejectedValue(Error('cache unavailable'))
    runner.script = async function* () {
      yield { type: 'progress', step: 1, actionLog: ['Changed booking.ts'], filesTouched: ['booking.ts'] }
      yield { type: 'answer', text: 'Implemented booking validation.' }
    }
    expect(await stream({ text: 'Implement booking validation', threadId }, requestId)).toBe(true)
    const saved = vi.mocked(chats.appendChatMessage).mock.calls.find(call => call[2].role === 'assistant')![2]
    expect(saved.contextResult).toMatchObject({
      terminal: 'incomplete',
      completion: { assessment: { status: 'partial', reason: 'The answer does not mention the date range check.' } }
    })
    expect(saved.content).toBe('Implemented booking validation.')
    expect(sent.some((item) => item.channel === 'chat:answer' && String(item.payload.chunk).includes('Outcome check'))).toBe(false)
    const done = sent.find((item) => item.channel === 'chat:done' && item.payload.requestId === requestId)
    expect(done?.payload.incomplete).toBe(true)
  })
  it.each(['transport-error', 'malformed-json', 'schema-invalid', 'response-limit'] as const)(
    'treats an unavailable reviewer (%s) as no verdict (#500)', async (failure) => {
      const { saved, incomplete } = await reviewedTurn({ verdict: 'unresolved', failure, reason: 'unavailable' })
      expect(incomplete).toBe(false)
      expect(saved.content).toBe('Implemented booking validation.')
      expect(saved.contextResult?.completion?.assessment).toMatchObject({ status: 'unresolved', failure })
    })
  it('keeps a missing-reference review conservative (#500)', async () => {
    const { saved, incomplete } = await reviewedTurn({
      verdict: 'unresolved', failure: 'reference-unavailable', reason: 'The referenced proposal is unavailable.'
    })
    expect(incomplete).toBe(true)
    expect(saved.content).toBe('Implemented booking validation.')
  })
  it('ignores renderer paging, recalls buried facts and persists the answer before terminal delivery', async () => {
    const chats = await import('../electron/main/services/chats')
    const { contextMemoryStore } = await import('../electron/main/services/context-memory-store')
    const { memoryKey } = await import('../electron/main/services/context-memory')
    const { emptyMemoryControls } = await import('../src/shared/context-memory')
    const requestId = randomUUID(),
      threadId = randomUUID(),
      root = appState.currentWorkspace
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      content:
        i === 2
          ? 'Remember: currency is EUR for checkout'
          : i === 999
            ? 'Recent checkout currency discussion'
            : `Message ${i}`,
      createdAt: 1
    }))
    const thread = {
      id: threadId,
      title: 'Bookings',
      model: 'builtin:composer-lite',
      messages,
      createdAt: 1,
      updatedAt: 1,
      contextRevision: 1,
      messageCount: 1000,
      messageOffset: 0
    }
    vi.spyOn(chats, 'getChat').mockResolvedValue({
      ...thread,
      messages: messages.slice(-1),
      messageOffset: 999
    })
    let assistantSaved = false
    vi.spyOn(chats, 'appendChatMessage').mockImplementation(async (_root, _id, message) => {
      if (message.role === 'assistant') {
        expect(channels()).not.toContain('chat:done')
        expect(message).toMatchObject({
          id: `${requestId}:assistant`,
          content: 'Use EUR for checkout.',
          contextResult: { terminal: 'done' }
        })
        assistantSaved = true
      }
      messages.push(message as (typeof messages)[number])
      return {
        ...thread,
        messages: messages.slice(-60),
        messageCount: messages.length,
        messageOffset: messages.length - 60
      }
    })
    const image = {
      id: 'generated-image',
      kind: 'image' as const,
      mimeType: 'image/png' as const,
      width: 512,
      height: 512,
      bytes: 1234,
      provider: 'local',
      model: 'sdxl',
      prompt: 'rental icon',
      createdAt: 1
    }
    const worker = await import('../electron/main/services/workspace-worker-client')
    vi.spyOn(worker, 'workspaceRequest').mockImplementation(async (req) => {
      if (req.type === 'context-source-scope') return false as never
      if (req.type === 'context-header')
        return { revision: 1, messageCount: 1000, sourceEpoch: 'scripted-history' } as never
      throw Error('Unexpected worker request')
    })
    const key = memoryKey(root, threadId)
    contextMemoryStore.configure(getResolvedSettings(root).agent.contextMemory)
    contextMemoryStore.install(
      key,
      {
        revision: 1,
        total: 1000,
        sourceEpoch: 'scripted-history',
        records: messages.map((message, ordinal) => ({ ordinal, message })),
        controls: emptyMemoryControls(),
        partial: false
      },
      contextMemoryStore.token(key)
    )
    runner.script = async function* (opts) {
      expect(opts.conversationMemory?.text).toContain('EUR')
      expect(opts.conversationMemory?.text).not.toContain('Recent checkout currency discussion')
      // Recent history follows the window, so more of the tail is already covered.
      expect(opts.conversationMemory?.manifest.duplicateSourceMessages).toBeGreaterThan(6)
      expect(opts.messages.some((m) => m.content === 'Recent checkout currency discussion')).toBe(
        true
      )
      expect(opts.messages.some((m) => m.content === 'Message 0')).toBe(false)
      expect(opts.messages.at(-1)?.content).toBe('What currency should checkout use?')
      yield { type: 'asset', asset: image }
      yield { type: 'thinking', text: '— Inspected currency settings' }
      yield { type: 'answer', text: 'Use EUR for checkout.' }
    }
    try {
      expect(
        await stream({ text: 'What currency should checkout use?', threadId }, requestId)
      ).toBe(true)
      expect(assistantSaved).toBe(true)
      const savedReply = vi
        .mocked(chats.appendChatMessage)
        .mock.calls.find((call) => call[2].role === 'assistant')![2]
      expect(savedReply.assets).toEqual([image])
      expect(savedReply.thinking).toContain('Inspected currency settings')
      expect(channels()).toContain('chat:done')
      expect(chats.getChat).toHaveBeenCalledWith(root, threadId, { limit: 1 })
    } finally {
      contextMemoryStore.clear()
    }
  })
  it('does not report success when the generated reply cannot be saved', async () => {
    const chats = await import('../electron/main/services/chats')
    const threadId = randomUUID()
    vi.spyOn(chats, 'getChat').mockResolvedValue({
      id: threadId,
      title: 'History',
      model: 'builtin:composer-lite',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    vi.spyOn(chats, 'appendChatMessage').mockImplementation(async (_root, _id, message) => {
      if (message.role === 'assistant') throw Error('disk full')
      return {
        id: threadId,
        title: 'History',
        model: 'builtin:composer-lite',
        messages: [message],
        createdAt: 1,
        updatedAt: 1
      }
    })
    const memory = await import('../electron/main/services/context-memory')
    vi.spyOn(memory, 'conversationContext').mockRejectedValue(Error('cache unavailable'))
    runner.script = async function* () {
      yield { type: 'answer', text: 'Generated reply' }
    }
    expect(await stream({ text: 'Explain RAM context', threadId })).toBe(false)
    expect(channels()).not.toContain('chat:done')
    expect(sent.find((e) => e.channel === 'chat:error')?.payload.error).toContain(
      'could not be saved'
    )
  })
})


describe('second chat admission and terminal events (#529)', () => {
  afterEach(() => vi.useRealTimers())
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }
  const eventsFor = (id: string) => sent.filter((event) => event.payload.requestId === id)

  it('admits and completes the next chat after normal completion', async () => {
    runner.script = async function* () { yield { type: 'answer', text: 'complete' } }
    const first = randomUUID(), second = randomUUID()
    expect(await stream(undefined, first)).toBe(true)
    expect(await stream(undefined, second)).toBe(true)
    expect(eventsFor(second).some((event) => event.channel === 'chat:phase' && event.payload.phase === 'routing')).toBe(true)
    expect(eventsFor(second).some((event) => event.channel === 'chat:done')).toBe(true)
  })

  it('admits the next chat promptly when the first honors stop', async () => {
    const entered = deferred()
    let calls = 0
    runner.script = async function* (options) {
      if (++calls === 1) {
        entered.resolve()
        await new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true }))
      }
      yield { type: 'answer', text: 'complete' }
    }
    const first = randomUUID(), second = randomUUID()
    const firstRun = stream(undefined, first)
    await entered.promise
    const secondRun = stream(undefined, second)
    await handlers['chat:stop']!({ sender }, first)
    expect(await firstRun).toBe(false)
    expect(await secondRun).toBe(true)
    expect(eventsFor(first).find((event) => event.channel === 'chat:done')?.payload.aborted).toBe(true)
    expect(eventsFor(second).some((event) => event.channel === 'chat:phase' && event.payload.phase === 'routing')).toBe(true)
  })

  it('queues the second chat and ignores late output after stop grace', async () => {
    vi.useFakeTimers()
    const entered = deferred(), unblock = deferred()
    let calls = 0
    runner.script = async function* () {
      if (++calls === 1) { entered.resolve(); await unblock.promise; yield { type: 'answer', text: 'late answer' } }
      else yield { type: 'answer', text: 'second answer' }
    }
    const first = randomUUID(), second = randomUUID()
    const firstRun = stream(undefined, first)
    await entered.promise
    const secondRun = stream(undefined, second)
    await vi.waitFor(() => expect(eventsFor(second).some((event) => event.channel === 'chat:phase' && event.payload.phase === 'queued' && event.payload.queuePosition === 1 && event.payload.blockedBy === first)).toBe(true))
    await handlers['chat:stop']!({ sender }, first)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await firstRun).toBe(false)
    expect(await secondRun).toBe(true)
    expect(eventsFor(second).some((event) => event.channel === 'chat:phase' && event.payload.phase === 'routing')).toBe(true)
    const count = eventsFor(first).length
    unblock.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(eventsFor(first)).toHaveLength(count)
    expect(eventsFor(first).some((event) => event.payload.chunk === 'late answer')).toBe(false)
  })

  it('admits a second chat after the first model fails', async () => {
    let calls = 0
    runner.script = async function* () {
      if (++calls === 1) throw new Error('model unavailable')
      yield { type: 'answer', text: 'recovered' }
    }
    const first = randomUUID(), second = randomUUID()
    expect(await stream(undefined, first)).toBe(false)
    expect(await stream(undefined, second)).toBe(true)
    expect(eventsFor(first).some((event) => event.channel === 'chat:error')).toBe(true)
    expect(eventsFor(second).some((event) => event.channel === 'chat:done')).toBe(true)
  })

  it('replays a duplicate request ID without invoking the model again', async () => {
    let calls = 0
    runner.script = async function* () { calls++; yield { type: 'answer', text: 'complete' } }
    const id = randomUUID()
    await stream(undefined, id)
    await stream(undefined, id)
    expect(calls).toBe(1)
  })
})
