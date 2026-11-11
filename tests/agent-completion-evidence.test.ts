import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * #499: edits whose files were already correct ran until the 15-minute limit.
 * Live repro was a plain HTML/JS to-do page: no package.json, so verification is
 * always skipped, and replies such as "Added … to todo.html. Let me know…" were
 * treated as unfinished. These tests replay that shape through the real loop.
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

import { runAgentWithWorkspaceTools } from '../electron/main/services/agent/loop'
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eris-completion-'))
  state.script.length = 0
  state.calls = 0
  state.verify = { ok: true, skipped: true, command: '', detail: 'No typecheck/test/lint script found — skipped verify.', skipReason: 'no-project-check' }
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const plan = (): TurnPlan => ({
  intent: 'edit', agentId: 'composer', agentName: 'Composer', mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'edit', requiresTools: true, escalateToFull: false, reason: 'test', method: 'manual'
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

const TODO_HTML = '<!DOCTYPE html>\n<html>\n<body>\n<ul id="todoList"></ul>\n<script src="todo.js"></script>\n</body>\n</html>\n'
const TODO_JS = 'function addTask() {\n  return 1\n}\n'

describe('edits on a project with no test or typecheck script (#499)', () => {
  it('finishes the live "Clear all" request once both files are edited', async () => {
    writeFileSync(join(ws, 'todo.html'), TODO_HTML)
    writeFileSync(join(ws, 'todo.js'), TODO_JS)
    state.script.push(
      call('read_file', { path: 'todo.html' }),
      call('search_replace', { path: 'todo.html', old_string: '<ul id="todoList"></ul>', new_string: '<button onclick="clearAllTasks()">Clear all</button>\n<ul id="todoList"></ul>' }),
      call('read_file', { path: 'todo.js' }),
      call('search_replace', { path: 'todo.js', old_string: '  return 1\n}\n', new_string: '  return 1\n}\n\nfunction clearAllTasks() {\n  document.getElementById("todoList").innerHTML = ""\n}\n' }),
      'I have added a "Clear all" button to todo.html and a clearAllTasks() handler in todo.js. Let me know if you need any further changes.'
    )
    const result = await run('Add a "Clear all" button to todo.html that removes every item from the list. Put the handler in todo.js.')
    expect(readFileSync(join(ws, 'todo.html'), 'utf8')).toContain('Clear all')
    expect(readFileSync(join(ws, 'todo.js'), 'utf8')).toContain('function clearAllTasks')
    expect(result.incomplete).toBe(false)
    expect(state.script).toHaveLength(0)
    // Five scripted steps plus at most a bounded final-answer pass; never a retry loop.
    expect(state.calls).toBeLessThanOrEqual(7)
    expect(result.events.some((e) => e.type === 'thinking' && /Outcome check failed|Not done yet/.test(String(e.text)))).toBe(false)
  })

  it('accepts a requested JS file by its syntax check and says so', async () => {
    state.script.push(
      call('write_file', { path: 'app.js', content: 'export function add(a, b) {\n  return a + b\n}\n' }),
      'Created app.js with an add function.'
    )
    const result = await run('Create app.js that exports a function add(a, b) returning the sum.')
    expect(result.incomplete).toBe(false)
    expect(result.answer).toContain('This project has no test or typecheck script, so only the syntax of app.js was checked.')
  })

  it('still rejects a requested JS file with syntax errors', async () => {
    state.script.push(
      call('write_file', { path: 'app.js', content: 'export function add(a, b) {\n  return a +\n' }),
      'Created app.js.', 'Created app.js.', 'Created app.js.', 'Created app.js.'
    )
    const result = await run('Create app.js that exports a function add(a, b) returning the sum.')
    expect(result.incomplete).toBe(true)
    expect(result.events.some((e) => e.type === 'thinking' && /app\.js: syntax errors/.test(String(e.text)))).toBe(true)
  })

  it('does not treat disabled checks as a project without checks', async () => {
    state.verify = { ok: true, skipped: true, command: '', detail: 'Diagnostics run: verify was skipped.', skipReason: 'diagnostics' }
    state.script.push(
      call('write_file', { path: 'app.js', content: 'export const one = 1\n' }),
      'Created app.js.', 'Created app.js.', 'Created app.js.', 'Created app.js.'
    )
    const result = await run('Create app.js that exports one.')
    expect(result.incomplete).toBe(true)
    expect(result.events.some((e) => e.type === 'thinking' && /project checks are disabled/.test(String(e.text)))).toBe(true)
  })

  it('finishes when a follow-up edit fails on a file it already wrote, and reports it', async () => {
    state.script.push(
      call('write_file', { path: 'todo.html', content: TODO_HTML }),
      call('write_file', { path: 'todo.js', content: TODO_JS }),
      call('read_file', { path: 'todo.html' }),
      call('search_replace', { path: 'todo.html', old_string: 'not in the file', new_string: 'x' }),
      'Created todo.html and todo.js for the to-do page.'
    )
    const result = await run('Build a to-do list page in todo.html with the JavaScript in todo.js.')
    expect(result.incomplete).toBe(false)
    expect(result.answer).toContain('A later edit to todo.html failed and was not applied')
  })

  it('keeps a failed edit on a file the run never changed incomplete', async () => {
    writeFileSync(join(ws, 'todo.html'), TODO_HTML)
    state.script.push(
      call('read_file', { path: 'todo.html' }),
      call('search_replace', { path: 'todo.html', old_string: 'not in the file', new_string: 'x' }),
      'Updated todo.html.', 'Updated todo.html.', 'Updated todo.html.', 'Updated todo.html.'
    )
    const result = await run('Add a footer to todo.html.')
    expect(result.incomplete).toBe(true)
  })
})

describe('a broken HTML edit is not reported as correct (#509)', () => {
  const PAGE = '<!DOCTYPE html>\n<html>\n<body>\n<h1>Hello</h1>\n<footer>\n<p>© 2026 Eris</p>\n</footer>\n</body>\n</html>\n'

  it('rejects the duplicated footer once, then finishes after the fix without claiming it is verified', async () => {
    writeFileSync(join(ws, 'hello.html'), PAGE)
    state.script.push(
      call('read_file', { path: 'hello.html' }),
      call('search_replace', { path: 'hello.html', old_string: '</footer>\n</body>', new_string: '</footer>\n<p>© 2026 Eris</p>\n</footer>\n</body>' }),
      'The hello.html file has been updated with the correct footer.',
      call('read_file', { path: 'hello.html' }),
      call('search_replace', { path: 'hello.html', old_string: '</footer>\n<p>© 2026 Eris</p>\n</footer>', new_string: '</footer>' }),
      'The hello.html file has been updated with the correct footer and verified.'
    )
    const result = await run('Add a footer to hello.html')
    const thinking = result.events.filter((e) => e.type === 'thinking').map((e) => String(e.text)).join('')
    expect(thinking).toMatch(/hello\.html: broken HTML: unbalanced <\/footer>/)
    expect(readFileSync(join(ws, 'hello.html'), 'utf8').match(/<footer>/g)).toHaveLength(1)
    expect(result.incomplete).toBe(false)
    expect(result.answer).toMatch(/^The hello\.html file has been updated with the footer\./)
    expect(result.answer).not.toMatch(/\bcorrect\b|and verified/i)
    expect(result.answer).toContain('Not verified: this project has no test or typecheck script.')
  })
})
