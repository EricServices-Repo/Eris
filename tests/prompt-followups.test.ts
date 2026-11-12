import { describe, expect, it } from 'vitest'
import { COMPOSER_OPENAI_TOOLS, getToolContract } from '../electron/main/services/tool-registry'
import { modelPromptMessages, textToolCatalog } from '../electron/main/services/model-protocol'
import { webSearchNudgeText } from '../electron/main/services/agent/prompts'
import { validateToolArguments } from '../electron/main/services/agent/tool-validation'
import { modelFacingTask } from '../electron/main/services/agent/context-compiler'
import { createTaskContract } from '../electron/main/services/task-intake'
import { artifactResponseContract } from '../src/shared/task-interpretation'
import { interpretationOf } from '../src/shared/task-contract'
import type { TurnPlan } from '../src/shared/settings-schema'

// #540: follow-up prompt review.
const core = COMPOSER_OPENAI_TOOLS.filter((tool) => getToolContract(tool.function.name)?.discovery === 'core')
const params = (name: string) =>
  Object.keys((COMPOSER_OPENAI_TOOLS.find((tool) => tool.function.name === name)!.function.parameters as { properties: object }).properties)
const plan = (over: Partial<TurnPlan> = {}): TurnPlan => ({
  intent: 'edit', agentId: 'composer', agentName: 'Composer', mode: 'agent',
  models: { chat: 'simulated:x', tools: 'simulated:x' }, toolPolicy: 'edit',
  requiresTools: true, escalateToFull: false, reason: 'test', method: 'manual', ...over
})

describe('tool definitions a model reads', () => {
  it('describes every core tool in at least a sentence', () => {
    for (const tool of core)
      expect((tool.function.description ?? '').length, tool.function.name).toBeGreaterThanOrEqual(40)
  })

  it('advertises one name per parameter', () => {
    expect(params('search_replace')).toEqual(['path', 'old_string', 'new_string', 'start_line', 'replace_all'])
    expect(params('apply_patch')).toEqual(['patch'])
    expect(params('grep')).toEqual(['pattern', 'glob'])
    expect(params('retrieve')).toEqual(['query'])
    expect(params('ask_user')).toEqual(['question', 'choices'])
    const camel = /^[a-z]+[A-Z]/
    for (const tool of COMPOSER_OPENAI_TOOLS)
      for (const name of params(tool.function.name))
        // No camelCase twin of a snake_case parameter (maxDepth has no twin).
        expect(camel.test(name) && params(tool.function.name).includes(name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)), `${tool.function.name}.${name}`).toBe(false)
  })

  it('makes the single remaining alternative required', () => {
    const grep = COMPOSER_OPENAI_TOOLS.find((tool) => tool.function.name === 'grep')!.function.parameters as { required: string[]; anyOf?: unknown }
    expect(grep.required).toEqual(['pattern'])
    expect(grep.anyOf).toBeUndefined()
  })

  it('still accepts the alias spellings models already use', () => {
    const ok = (name: string, args: Record<string, unknown>) => validateToolArguments(args, getToolContract(name)!.schema).ok
    expect(ok('search_replace', { path: 'a.ts', oldString: 'a', newString: 'b' })).toBe(true)
    expect(ok('grep', { query: 'TODO' })).toBe(true)
    expect(ok('apply_patch', { diff: '--- a\n+++ b\n' })).toBe(true)
    expect(ok('ask_user', { prompt: 'Which one?' })).toBe(true)
  })
})

describe('text-tools catalog', () => {
  const catalog = textToolCatalog(core)

  it('lists each tool as a signature with required arguments first', () => {
    expect(catalog).toMatch(/^- read_file\(path, start_line\?: integer, end_line\?: integer\) — Read a text file/m)
    expect(catalog).toMatch(/^- search_replace\(path, old_string, new_string, start_line\?: integer, replace_all\?: boolean\) — /m)
    expect(catalog).toMatch(/^ {4}cwd: Directory relative to the workspace/m)
    for (const tool of core) expect(catalog, tool.function.name).toContain(`- ${tool.function.name}`)
  })

  it('is well under two thirds of the JSON schemas it replaces', () => {
    const json = JSON.stringify(core.map((tool) => tool.function)).length
    expect(catalog.length).toBeLessThan(json * 0.65)
  })

  it('keeps the full schema for a tool with nested arguments', () => {
    const nested = textToolCatalog([{ type: 'function', function: { name: 'mcp_create', description: 'Create an item', parameters: { type: 'object', properties: { item: { type: 'object', properties: { title: { type: 'string' } } } }, required: ['item'] } } }])
    expect(nested).toContain('JSON schema: {"type":"object","properties":{"item"')
  })

  it('is injected only for text-tools models', () => {
    const messages = [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'u' }]
    expect(modelPromptMessages(messages, core, 'text-tools')[1]!.content).toBe(catalog)
    expect(modelPromptMessages(messages, core, 'native-tools')).toHaveLength(2)
  })
})

describe('web-search nudge', () => {
  it('names the tool for native tools and shows the envelope only for text tools', () => {
    const native = webSearchNudgeText('latest TypeScript release', 'native-tools')
    expect(native).toContain('Call the web_search tool now with the query "latest TypeScript release".')
    expect(native).not.toMatch(/"name"\s*:|<<<TOOL>>>/)
    expect(webSearchNudgeText('x', 'text-tools')).toContain('<<<TOOL>>>\n{"name":"web_search","arguments":{"query":"x"}}\n<<<END>>>')
  })
})

describe('model-facing task', () => {
  it('keeps the trace identity and drops what the model cannot use', () => {
    const task = createTaskContract({ workspacePath: null, text: 'Write a python function that reverses a string', plan: plan({ intent: 'answer', toolPolicy: 'none', mode: 'ask' }) })
    const facing = modelFacingTask(task)
    expect(facing).toMatchObject({ schema: 'model-task/7', taskId: task.taskId, revision: 1, intent: 'answer' })
    for (const key of ['acceptanceCriteria', 'assignment', 'requested']) expect(facing, key).not.toHaveProperty(key)
    expect(JSON.stringify(facing)).not.toMatch(/are claimed/)
  })

  it('shows requested work only where it differs from what will be delivered', () => {
    const task = createTaskContract({ workspacePath: null, text: 'Create index.html and about.html', plan: plan() })
    expect(modelFacingTask(task).requested).toEqual({ targetFiles: task.requested!.targetFiles })
    expect(modelFacingTask({ ...task, parentTaskId: 'p' }).assignment).toEqual({ kind: 'child', reportTo: 'coordinator' })
  })
})

describe('response contract for generic requests', () => {
  const contract = (text: string) => {
    const task = createTaskContract({ workspacePath: null, text, plan: plan({ intent: 'answer', toolPolicy: 'none', mode: 'ask' }) })
    return artifactResponseContract(interpretationOf(task), task.scope.applicability)
  }
  it('adds the conversation paragraph to a conversational request only', () => {
    expect(contract('Write a python function that reverses a string')).not.toMatch(/creative writing/)
    expect(contract('Write me a short poem about autumn')).toMatch(/creative writing/)
  })
})

describe('one intent table for both classifiers', () => {
  it('defines every chat intent once, with an example', async () => {
    const { INTENT_DEFINITIONS, INTENT_GUIDE, INTENT_RULES } = await import('../src/shared/intent-guide')
    expect(INTENT_DEFINITIONS.map((entry) => entry.intent).sort()).toEqual(
      ['answer', 'capability', 'edit', 'explore', 'plan', 'review', 'run', 'verify']
    )
    // The cases that were misrouted before #503, #504 and #508.
    expect(INTENT_GUIDE).toMatch(/- run — .*Run ls -la/)
    expect(INTENT_GUIDE).toMatch(/- explore — .*What files are in this project/)
    expect(INTENT_RULES).toMatch(/Read-only is the default/)
    expect(INTENT_RULES).toMatch(/what the previous turn changed is answer/)
  })

  it('is the only intent wording in the router and the resolver', async () => {
    const { readFileSync } = await import('fs')
    for (const file of ['electron/main/services/chat-router.ts', 'electron/main/services/task-resolver.ts']) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toMatch(/\$\{INTENT_GUIDE\}/)
      expect(source, file).toMatch(/\$\{INTENT_RULES\}/)
      expect(source, file).not.toMatch(/Prefer edit over answer|prefer edit`|explore: explain code/)
    }
  })
})

describe('host notes on OpenAI-compatible connections', () => {
  it('sends later system messages as marked user messages', async () => {
    const { hostNotesAsUser, HOST_NOTE_PREFIX } = await import('../electron/main/services/openai-compatible')
    const out = hostNotesAsUser([
      { role: 'system', content: 'instructions' },
      { role: 'system', content: 'tool catalog' },
      { role: 'user', content: 'Add a button' },
      { role: 'assistant', content: 'I would add it.' },
      { role: 'system', content: 'You must use tools to finish this request.' }
    ])
    expect(out.map((message) => message.role)).toEqual(['system', 'system', 'user', 'assistant', 'user'])
    expect(out[4]!.content).toBe(`${HOST_NOTE_PREFIX}\nYou must use tools to finish this request.`)
  })

  it('leaves a note between a tool call and its result alone', async () => {
    const { hostNotesAsUser } = await import('../electron/main/services/openai-compatible')
    const out = hostNotesAsUser([
      { role: 'system', content: 's' },
      { role: 'assistant', content: null },
      { role: 'system', content: 'note' },
      { role: 'tool', content: 'result' }
    ])
    expect(out[2]!.role).toBe('system')
  })
})
