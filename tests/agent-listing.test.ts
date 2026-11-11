import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #508: "What files are in this project? List them." ran tree and then ended
 * "Incomplete: The agent produced no successful workspace evidence." The listing
 * is the answer to a listing question.
 */

const state = vi.hoisted(() => ({
  script: [] as string[],
  calls: 0,
  verify: { ok: true, skipped: true, command: '', detail: 'No typecheck/test/lint script found — skipped verify.', skipReason: 'no-project-check' } as Record<string, unknown>
}))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* () {
    state.calls++
    yield state.script.shift() ?? 'Finished.'
  }
}))
vi.mock('../electron/main/services/verify', () => ({ runVerify: async () => ({ ...state.verify }) }))
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

import { classifyIntentTraced } from '../electron/main/services/chat-router'
import { AgentWorkflow } from '../electron/main/services/agent/workflow'
import { listedPaths, listingAnswer } from '../electron/main/services/agent/listing-answer'
import { asksForFileListing } from '../src/shared/agent-contract'
import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'eris-listing-')))
  state.script.length = 0
  state.calls = 0
  state.verify = { ok: true, skipped: true, command: '', detail: 'No typecheck/test/lint script found — skipped verify.', skipReason: 'no-project-check' }
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const plan = (): TurnPlan => ({
  intent: 'explore', agentId: 'explainer', agentName: 'Explainer', mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'read', requiresTools: true, escalateToFull: false, reason: 'test', method: 'manual'
})
const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ name, ...args })

async function run(text: string) {
  const turnPlan = plan()
  turnPlan.task = createTaskContract({ workspacePath: ws, text, plan: turnPlan })
  const events: Array<Record<string, unknown>> = []
  for await (const event of runAgentWithWorkspaceTools({
    workspacePath: ws, settings: getDefaults(), model: 'builtin:composer-lite',
    messages: [{ role: 'user', content: text }], temperature: 0, getSecret: () => null,
    mode: 'agent', turnPlan, mcp: 'off'
  }))
    events.push(event as Record<string, unknown>)
  const answer = events.filter((e) => e.type === 'answer')
    .reduce((text, e) => (e.replace ? String(e.text) : text + String(e.text)), '')
  return { events, answer, incomplete: events.some((e) => e.incomplete === true) }
}

const T4 = 'What files are in this project? List them.'
const fixture = () => {
  writeFileSync(join(ws, 'index.html'), '<h1>Hi</h1>')
  writeFileSync(join(ws, 'todo.js'), 'export {}')
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src', 'app.css'), 'body{}')
}

describe('#508 listing questions', () => {
  it('answers from a tree call', async () => {
    fixture()
    state.script.push(
      call('tree', { path: '.' }),
      'The project contains index.html, todo.js and src/app.css. Those are all the files in this workspace.'
    )
    const result = await run(T4)
    expect(result.incomplete).toBe(false)
    for (const name of ['index.html', 'todo.js', 'app.css']) expect(result.answer).toContain(name)
    expect(result.answer).not.toMatch(/no successful workspace evidence/)
  }, 30_000)

  it('counts the auto-run tree as evidence when the model asks for the structure', async () => {
    fixture()
    state.script.push(
      'Please provide the project structure so I can list the files.',
      'The files are index.html, todo.js and src/app.css, which is everything in the project folder.'
    )
    const result = await run(T4)
    expect(result.events.some((e) => e.type === 'evidence')).toBe(true)
    expect(result.incomplete).toBe(false)
    expect(result.answer).not.toMatch(/no successful workspace evidence/)
  }, 30_000)
})

describe('#508 listing contract and formatter', () => {
  const plan = (intent: TurnPlan['intent'] = 'explore'): TurnPlan => ({
    intent, agentId: 'explainer', agentName: 'Explainer', mode: 'agent',
    models: { chat: 'local:test', tools: 'local:test' },
    toolPolicy: 'read', requiresTools: true, escalateToFull: false, reason: 'test', method: 'heuristic'
  })
  const outcome = (workflow: AgentWorkflow) =>
    workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false })

  it('detects listing questions and leaves questions about code alone', () => {
    for (const text of [
      T4, 'List the files in this project', 'Show me the folder structure', 'Which files are in src?',
      'Can you list all the files?', "What's the project structure?"
    ])
      expect(asksForFileListing(text), text).toBe(true)
    for (const text of [
      'Which files handle login?', 'List the files that use React', 'Review the files in src',
      'Explain the folder structure', 'Add a file to the project'
    ])
      expect(asksForFileListing(text), text).toBe(false)
  })

  it('routes listing questions to a read agent with project scope', () => {
    expect(classifyIntentTraced('List the files in this project', 'agent')).toEqual({ intent: 'explore', rule: 'file-listing' })
    expect(classifyIntentTraced('Which files are in src?', 'agent').intent).toBe('explore')
  })

  it('accepts one successful listing for a listing contract', () => {
    const workflow = new AgentWorkflow(plan(), T4)
    expect(workflow.contract.listingSatisfies).toBe(true)
    workflow.noteTool({ ok: true, mutated: false, name: 'tree', path: '.' })
    expect(outcome(workflow).ok).toBe(true)
    expect(workflow.listingObserved()).toBe(true)
  })

  it('does not accept a failed listing', () => {
    const workflow = new AgentWorkflow({ ...plan(), task: createTaskContract({ workspacePath: ws, text: T4, plan: plan() }) }, T4)
    workflow.noteTool({ ok: false, mutated: false, name: 'tree', path: '.' })
    expect(workflow.listingObserved()).toBe(false)
  })

  it('still requires a source read for a review after only a tree', () => {
    const review = { ...plan('review'), agentId: 'reviewer', agentName: 'Reviewer' }
    const task = createTaskContract({ workspacePath: ws, text: 'Review the code in this project', plan: review })
    const workflow = new AgentWorkflow({ ...review, task }, 'Review the code in this project')
    expect(workflow.contract.listingSatisfies).toBeUndefined()
    workflow.noteTool({ ok: true, mutated: false, name: 'tree', path: '.' })
    expect(outcome(workflow).ok).toBe(false)
  })

  it('formats tree and list_dir output as a file list', () => {
    expect(listedPaths('./\n  index.html\n  .eris/\n    rules.md\n  src/\n    app.js\n    lib/\n      a.ts')).toEqual([
      'index.html', 'src/', 'src/app.js', 'src/lib/', 'src/lib/a.ts'
    ])
    expect(listedPaths('file index.html (2b)\ndir  src')).toEqual(['index.html', 'src/'])
    const answer = listingAnswer('./\n  index.html\n  todo.js', 'The run stopped early.')!
    expect(answer).toContain('2 files')
    expect(answer).toContain('- `todo.js`')
    expect(answer.endsWith('The run stopped early.')).toBe(true)
    expect(listingAnswer('', 'x')).toBeNull()
  })
})
