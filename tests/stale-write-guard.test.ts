import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTaskContract } from '../electron/main/services/task-intake'
import { executeTool } from '../electron/main/services/agent/execute-tool'
import { TaskToolGateway } from '../electron/main/services/agent/tool-gateway'
import type { TurnPlan } from '../src/shared/settings-schema'
import type { ToolCall } from '../electron/main/services/agent/types'

const plan: TurnPlan = {
  intent: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  mode: 'agent',
  toolPolicy: 'edit',
  requiresTools: true,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  models: { chat: 'local:test', tools: 'local:test' }
}
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })))
function setup(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'eris-stale-'))
  roots.push(root)
  mkdirSync(join(root, 'app'))
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
  const task = createTaskContract({ workspacePath: root, text: 'Fix the app code', plan })
  return { root, gateway: new TaskToolGateway(task) }
}
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ name, args, raw: '' })

describe('compare-and-apply against the observed revision (#456)', () => {
  it('uses the revision the model saw, not the file as it is when the receipt is recorded', () => {
    const { root, gateway } = setup({ 'app/index.js': 'const a = 1\n' })
    const read = call('read_file', { path: 'app/index.js' })
    const result = executeTool(root, read)
    expect(result.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
    // External edit lands between the read returning and its receipt being recorded.
    writeFileSync(join(root, 'app/index.js'), 'const a = 2 // external\n')
    gateway.record('r1', read, result)
    const edit = call('search_replace', {
      path: 'app/index.js',
      old_string: 'const a',
      new_string: 'let a'
    })
    expect(gateway.authorize(root, edit)).toContain('changed after inspection')
    expect(readFileSync(join(root, 'app/index.js'), 'utf8')).toBe('const a = 2 // external\n')
  })

  it('conflicts when a file absent at read time is created externally before write_file', () => {
    const { root, gateway } = setup()
    const read = call('read_file', { path: 'app/new.js' })
    const result = executeTool(root, read)
    expect(result.ok).toBe(false)
    gateway.record('r1', read, result)
    writeFileSync(join(root, 'app/new.js'), 'external content')
    const denied = gateway.authorize(root, call('write_file', { path: 'app/new.js', content: 'x' }))
    expect(denied).toContain('created by another process')
    expect(readFileSync(join(root, 'app/new.js'), 'utf8')).toBe('external content')
  })

  it('still allows creating a file that remains absent after a not-found read', () => {
    const { root, gateway } = setup()
    const read = call('read_file', { path: 'app/new.js' })
    gateway.record('r1', read, executeTool(root, read))
    expect(gateway.authorize(root, call('write_file', { path: 'app/new.js', content: 'x' }))).toBe(
      null
    )
  })

  it('reports a change while waiting for the write lock as a conflict, not a bad path', () => {
    const { root, gateway } = setup({ 'app/index.js': 'one\n' })
    const read = call('read_file', { path: 'app/index.js' })
    gateway.record('r1', read, executeTool(root, read))
    const edit = call('search_replace', {
      path: 'app/index.js',
      old_string: 'one',
      new_string: 'two'
    })
    expect(gateway.authorize(root, edit)).toBe(null)
    writeFileSync(join(root, 'app/index.js'), 'external\n')
    const stale = gateway.authorize(root, edit)
    expect(stale).not.toContain('Invalid scoped tool path')
    expect(stale).toMatch(/changed/)
    expect(readFileSync(join(root, 'app/index.js'), 'utf8')).toBe('external\n')
  })

  it('accepts the edit after the model re-reads the externally changed file', () => {
    const { root, gateway } = setup({ 'app/index.js': 'one\n' })
    const read = call('read_file', { path: 'app/index.js' })
    gateway.record('r1', read, executeTool(root, read))
    writeFileSync(join(root, 'app/index.js'), 'external\n')
    const fresh = call('read_file', { path: 'app/index.js' })
    gateway.record('r2', fresh, executeTool(root, fresh))
    const edit = call('search_replace', {
      path: 'app/index.js',
      old_string: 'external',
      new_string: 'merged'
    })
    expect(gateway.authorize(root, edit)).toBe(null)
    const applied = executeTool(root, edit, gateway.mutationPlan(edit))
    expect(applied.ok).toBe(true)
    expect(readFileSync(join(root, 'app/index.js'), 'utf8')).toBe('merged\n')
  })

  it('fails publication when the file changes after authorization', () => {
    const { root, gateway } = setup({ 'app/index.js': 'one\n' })
    const read = call('read_file', { path: 'app/index.js' })
    gateway.record('r1', read, executeTool(root, read))
    const edit = call('write_file', { path: 'app/index.js', content: 'ours\n' })
    expect(gateway.authorize(root, edit)).toBe(null)
    writeFileSync(join(root, 'app/index.js'), 'external\n')
    const result = executeTool(root, edit, gateway.mutationPlan(edit))
    expect(result.ok).toBe(false)
    expect(result.mutated).toBe(false)
    expect(readFileSync(join(root, 'app/index.js'), 'utf8')).toBe('external\n')
  })
})
