import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { runInNewContext } from 'node:vm'
import { classifyIntent } from '../electron/main/services/chat-router'
import { join } from 'path'

/**
 * Scripted fake-model test for the core agent loop: replays a model that emits a
 * write_file tool call and then a DONE reply, against a real temp workspace, and
 * asserts the file was written and the loop finished. Guards the loop's parse →
 * dispatch → checkpoint → summary path against regressions.
 */

// Replay queue: each entry is the full assistant text for one model turn.
const script: string[] = []
let scriptAdvanceMs = 0
vi.mock('../electron/main/services/chat-runtime', () => ({
  // eslint-disable-next-line require-yield
  streamModelChat: async function* () {
    if (scriptAdvanceMs) vi.advanceTimersByTime(scriptAdvanceMs)
    const next = script.shift() ?? 'DONE: nothing left to do.'
    yield next
  }
}))

// Keep the loop off the network / heavy subsystems.
vi.mock('../electron/main/services/verify', () => ({
  runVerify: async () => ({ ok: true, skipped: true, command: '', detail: '' })
}))
vi.mock('../electron/main/services/mcp-runtime', () => ({
  syncMcpRuntime: async () => undefined,
  listMcpTools: () => [],
  isMcpToolName: () => false,
  callMcpTool: async () => ({ ok: false, detail: 'no mcp' }),
  formatLiveMcpToolsPrompt: () => ''
}))
vi.mock('../electron/main/services/workspace-search', () => ({
  retrieveContextAsync: async () => ({ ok: true, paths: [], detail: '' }),
  workspaceGlob: () => ({ ok: true, detail: '' }),
  workspaceGrep: async () => ({ ok: true, detail: '' })
}))
vi.mock('../electron/main/services/code-index', () => ({
  findReferences: () => ({ ok: true, detail: '' }),
  findSymbols: () => ({ ok: true, detail: '' }),
  relatedFiles: () => ({ ok: true, detail: '' }),
  formatIndexSummary: () => ''
}))

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { truncateForModel } from '../electron/main/services/agent/prompts'
import { RunJournal } from '../electron/main/services/agent/run-journal'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { AgentChatMessage } from '../electron/main/services/agent/types'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eris-loop-'))
  script.length = 0
  scriptAdvanceMs = 0
})
afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function editPlan(): TurnPlan {
  return {
    intent: 'edit',
    agentId: 'composer',
    agentName: 'Composer',
    mode: 'agent',
    models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
    toolPolicy: 'edit',
    requiresTools: true,
    escalateToFull: false,
    reason: 'test',
    method: 'manual'
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const e of gen) events.push(e as Record<string, unknown>)
  return events
}

describe('agent loop (scripted model)', () => {
  it('does not spend the run deadline while waiting for a user reply (#525)', async () => {
    vi.useFakeTimers()
    try {
      const text = 'Create notes.txt with the greeting I choose'
      const plan = editPlan()
      plan.task = createTaskContract({ workspacePath: ws, text, plan })
      const settings = structuredClone(getDefaults())
      settings.agent.maxRunMinutes = 1
      script.push(JSON.stringify({ name: 'ask_user', question: 'Which greeting should I use?' }),
        JSON.stringify({ name: 'write_file', path: 'notes.txt', content: 'Hello' }),
        'Created notes.txt with the greeting Hello.')
      const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings,
        model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
        getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off',
        askUser: async () => { await vi.advanceTimersByTimeAsync(120_000); return 'Hello' } }))
      expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('Hello')
      expect(events.some(event => String(event.text).includes('Run time limit reached'))).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('stops repeated rejected prose instead of looping indefinitely (#526)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
      const text = 'Create a new file called notes.txt with a greeting'
      const plan = editPlan()
      plan.task = createTaskContract({ workspacePath: ws, text, plan })
      script.push(...Array(6).fill('I will create the requested file shortly.'))
      const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings: getDefaults(),
        model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
        getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off' }))
      expect(events.some(event => event.incomplete === true)).toBe(true)
      expect(events.some(event => event.type === 'status' && String(event.text).includes('recovery exhausted'))).toBe(true)
      expect(events.some(event => event.type === 'status' && String(event.text).includes('Recovering'))).toBe(true)
      expect(existsSync(join(ws, 'notes.txt'))).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('stops different rejected replies after the no-progress time limit (#526)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
      scriptAdvanceMs = 100_000
      const text = 'Create notes.txt with a greeting'
      const plan = editPlan()
      plan.task = createTaskContract({ workspacePath: ws, text, plan })
      script.push('I will create the requested file shortly.', 'I will start creating the file now.')
      const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings: getDefaults(),
        model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
        getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off' }))
      expect(events.some(event => event.type === 'status' && String(event.text).includes('recovery exhausted'))).toBe(true)
      expect(events.some(event => event.incomplete === true)).toBe(true)
    } finally { vi.useRealTimers(); scriptAdvanceMs = 0 }
  })
  it('does not stop a run that keeps reading new evidence over ten minutes (#526)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
      scriptAdvanceMs = 140_000
      const text = 'Review the files and describe their contents'
      const plan = { ...editPlan(), intent: 'review' as const, toolPolicy: 'read' as const }
      plan.task = createTaskContract({ workspacePath: ws, text, plan })
      for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) writeFileSync(join(ws, name), name)
      script.push(...['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(path => JSON.stringify({ name: 'read_file', path })),
        'The files a.txt, b.txt, c.txt, and d.txt each contain their names.')
      const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings: getDefaults(),
        model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
        getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off' }))
      expect(events.some(event => event.type === 'status' && String(event.text).includes('not using tools'))).toBe(false)
      expect(script.length).toBe(0)
    } finally { vi.useRealTimers(); scriptAdvanceMs = 0 }
  })
  it('excludes time waiting for the user from the no-progress clock (#526)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
      const text = 'Create notes.txt with the greeting I choose'
      const plan = editPlan()
      plan.task = createTaskContract({ workspacePath: ws, text, plan })
      script.push(JSON.stringify({ name: 'ask_user', question: 'Which greeting should I use?' }),
        JSON.stringify({ name: 'write_file', path: 'notes.txt', content: 'Hello' }),
        'Created notes.txt with the greeting Hello.')
      const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings: getDefaults(),
        model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
        getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off',
        askUser: async () => { vi.setSystemTime(Date.now() + 240_000); return 'Hello' } }))
      expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('Hello')
      expect(events.some(event => event.type === 'status' && String(event.text).includes('recovery exhausted'))).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('keeps an unchanged named-output patch incomplete through the real loop (#443)', async () => {
    const text='Create report.txt containing the new result'
    const plan=editPlan()
    plan.task=createTaskContract({workspacePath:ws,text,plan})
    writeFileSync(join(ws,'report.txt'),'Old result')
    script.push(JSON.stringify({name:'read_file',path:'report.txt'}),'DONE: report.txt is ready.')
    const events=await drain(runAgentWithWorkspaceTools({workspacePath:ws,settings:getDefaults(),
      model:'builtin:composer-lite',messages:[{role:'user',content:text}],temperature:0,getSecret:()=>null,
      mode:'agent',turnPlan:plan,mcp:'off'}))
    expect(readFileSync(join(ws,'report.txt'),'utf8')).toBe('Old result')
    expect(events.some(event=>event.incomplete===true)).toBe(true)
    expect(events.some(event=>event.type==='diff')).toBe(false)
  })
  it('reports an already-present rule as satisfied without touching the file (#457)', async () => {
    const source = 'export function validate(age) {\n  if (age < 0) throw new Error("age must be non-negative")\n  return age\n}\n'
    writeFileSync(join(ws, 'validate.js'), source)
    const before = statSync(join(ws, 'validate.js')).mtimeMs
    const text = 'Add validation to validate.js that rejects negative ages'
    const plan = editPlan()
    plan.task = createTaskContract({ workspacePath: ws, text, plan })
    script.push(
      JSON.stringify({ name: 'read_file', path: 'validate.js' }),
      JSON.stringify({
        name: 'confirm_unchanged',
        requirement: 'reject negative ages',
        path: 'validate.js',
        evidence: 'if (age < 0) throw new Error("age must be non-negative")'
      }),
      'DONE: validate.js already rejects negative ages; no changes were needed.'
    )
    const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings: getDefaults(),
      model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
      getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off' }))
    expect(readFileSync(join(ws, 'validate.js'), 'utf8')).toBe(source)
    expect(statSync(join(ws, 'validate.js')).mtimeMs).toBe(before)
    expect(events.some((event) => event.type === 'diff')).toBe(false)
    expect(events.some((event) => event.incomplete === true)).toBe(false)
    expect(events.some((event) => event.type === 'status' && String(event.text).includes('already satisfied'))).toBe(true)
  })
  it('does not accept a no-op whose quoted evidence is not in the file (#457)', async () => {
    writeFileSync(join(ws, 'validate.js'), 'export function validate(age) {\n  return age\n}\n')
    const text = 'Add validation to validate.js that rejects negative ages'
    const plan = editPlan()
    plan.task = createTaskContract({ workspacePath: ws, text, plan })
    script.push(
      JSON.stringify({ name: 'read_file', path: 'validate.js' }),
      JSON.stringify({
        name: 'confirm_unchanged',
        requirement: 'reject negative ages',
        path: 'validate.js',
        evidence: 'if (age < 0) throw new Error("negative")'
      }),
      'DONE: already handled.'
    )
    const events = await drain(runAgentWithWorkspaceTools({ workspacePath: ws, settings: getDefaults(),
      model: 'builtin:composer-lite', messages: [{ role: 'user', content: text }], temperature: 0,
      getSecret: () => null, mode: 'agent', turnPlan: plan, mcp: 'off' }))
    expect(events.some((event) => event.incomplete === true)).toBe(true)
    expect(events.some((event) => event.type === 'status' && String(event.text).includes('already satisfied'))).toBe(false)
  })
  it('writes a file from a tool call, then finishes on a DONE reply', async () => {
    script.push('{"name":"write_file","path":"hello.txt","content":"hi there\\n"}')
    script.push('DONE: created hello.txt')

    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'You are Composer.' },
      { role: 'user', content: 'Create hello.txt containing a greeting.' }
    ]

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath: ws,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages,
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: editPlan(),
        mcp: 'off'
      })
    )

    expect(existsSync(join(ws, 'hello.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toContain('hi there')

    const diff = events.find((e) => e.type === 'diff')
    expect(diff).toBeTruthy()
    const answer = events.find((e) => e.type === 'answer')
    expect(answer).toBeTruthy()
  })

  it('completes a small working helper after a behavioral check (#446)', async () => {
    const code='module.exports = (a,b) => a+b;'
    const verify=await import('../electron/main/services/verify')
    vi.spyOn(verify,'runVerify').mockImplementation(async()=>{
      const module={exports:(_a:number,_b:number)=>0}
      runInNewContext(readFileSync(join(ws,'sum.js'),'utf8'),{module},{timeout:50})
      const ok=module.exports(2,3)===5 && module.exports(-3,3)===0
      return {ok,skipped:false,command:'fixture-sum-behavior',detail:ok?'sum cases passed':'wrong sum'}
    })
    script.push(JSON.stringify({name:'write_file',path:'sum.js',content:code}),'DONE: Implemented sum.js and checked addition.')
    const events=await drain(runAgentWithWorkspaceTools({workspacePath:ws,settings:getDefaults(),
      model:'builtin:composer-lite',messages:[{role:'user',content:'Implement sum.js'}],temperature:0,
      getSecret:()=>null,mode:'agent',turnPlan:editPlan(),mcp:'off'}))
    expect(readFileSync(join(ws,'sum.js'),'utf8')).toBe(code)
    expect(events.some(event=>event.incomplete===true)).toBe(false)
  })
  it('journals the full tool result before the prompt truncates it, then releases it', async () => {
    writeFileSync(join(ws, 'big.txt'), 'line of output\n'.repeat(2000))
    script.push('{"name":"read_file","path":"big.txt"}')
    script.push('DONE: read it')
    const append = vi.spyOn(RunJournal.prototype, 'append')
    const before = contextMemoryStore.ledger.reservedBytes
    await drain(
      runAgentWithWorkspaceTools({
        workspacePath: ws,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [
          { role: 'system', content: 'You are Composer.' },
          { role: 'user', content: 'Read big.txt.' }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'agent',
        turnPlan: editPlan(),
        mcp: 'off'
      })
    )
    const journaled = append.mock.calls.find(([input]) => input.toolName === 'read_file')?.[0]
    append.mockRestore()
    expect(journaled?.content.length).toBeGreaterThan(truncateForModel('x'.repeat(40_000)).length)
    expect(journaled?.toolCallId).toBeTruthy()
    expect(contextMemoryStore.ledger.reservedBytes).toBe(before)
  })

  it('implements a combined review-and-improve request using permitted tools (#436)', async () => {
    const text = 'Review the files and improve the layout'
    const plan: TurnPlan = { ...editPlan(), intent: classifyIntent(text, 'agent') }
    const { createTaskContract } = await import('../electron/main/services/task-intake')
    plan.task = createTaskContract({workspacePath:ws,text,plan})
    writeFileSync(join(ws, 'index.html'), '<main>Old layout</main>')
    script.push(JSON.stringify({name:'read_file',path:'index.html'}),
      JSON.stringify({name:'write_file',path:'index.html',content:'<main class="layout">Updated layout</main>'}),
      'DONE: Updated the layout in index.html.')
    const events = await drain(runAgentWithWorkspaceTools({workspacePath:ws,settings:getDefaults(),
      model:'builtin:composer-lite',messages:[{role:'user',content:text}],temperature:0,getSecret:()=>null,
      mode:'agent',turnPlan:plan,mcp:'off'}))
    expect(plan.task.authority.edit).toBe(true)
    expect(readFileSync(join(ws,'index.html'),'utf8')).toContain('class="layout"')
    expect(events.some(event=>event.type==='diff')).toBe(true)
    expect(events.filter(event=>event.incomplete===true)).toHaveLength(0)
  })
  it('answers directly in ask mode without touching the workspace', async () => {
    script.push('Here is an explanation, no tools needed.')
    const plan = editPlan()
    plan.mode = 'ask'
    plan.intent = 'answer'
    plan.requiresTools = false
    plan.toolPolicy = 'none'

    const events = await drain(
      runAgentWithWorkspaceTools({
        workspacePath: ws,
        settings: getDefaults(),
        model: 'builtin:composer-lite',
        messages: [
          { role: 'system', content: 'You are Composer.' },
          { role: 'user', content: 'Explain what a closure is.' }
        ],
        temperature: 0,
        getSecret: () => null,
        mode: 'ask',
        turnPlan: plan,
        mcp: 'off'
      })
    )
    const answer = events.find((e) => e.type === 'answer')
    expect(answer).toBeTruthy()
    expect(String((answer as { text: string }).text)).toContain('explanation')
  })
})

describe('Auto story request through the actual answer-only agent loop', () => {
  it.each([true, false])(
    'handles a bare refusal with bounded recovery (recovers=%s)',
    async (recovers) => {
      const refusal = "I'm sorry, but I can't assist with that request."
      const story =
        'Hans followed a trail of blue ribbons through the village. At the last gate, his best friend was waiting with a warm blanket and a very large biscuit.'
      script.push(refusal, recovers ? story : refusal)
      const plan: TurnPlan = {
        ...editPlan(),
        agentId: 'fast',
        agentName: 'Fast',
        intent: 'answer',
        requiresTools: false,
        toolPolicy: 'none',
        method: 'heuristic'
      }
      const events = await drain(
        runAgentWithWorkspaceTools({
          workspacePath: ws,
          settings: getDefaults(),
          model: 'builtin:composer-lite',
          messages: [
            { role: 'system', content: 'You are Fast.' },
            { role: 'user', content: 'Write a story about a dog named Hans' }
          ],
          temperature: 0.3,
          getSecret: () => null,
          mode: 'agent',
          turnPlan: plan,
          mcp: 'off'
        })
      )
      expect(events.some((event) => event.type === 'tool' || event.type === 'diff')).toBe(false)
      expect(script).toHaveLength(0)
      if (recovers) {
        expect(events.filter((event) => event.type === 'answer').at(-1)?.text).toBe(story)
        expect(events.some((event) => event.type === 'progress' && event.incomplete)).toBe(false)
      } else {
        expect(events.some((event) => event.type === 'progress' && event.incomplete === true)).toBe(
          true
        )
      }
    }
  )
})
