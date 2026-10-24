import { describe, expect, it } from 'vitest'
import {
  parseCloudTask,
  scopePrefix,
  assertTaskTool,
  assertExternal,
  canEdit,
  artifactPath
} from '../cloud-agent/src/task-policy'
const contract = () => ({
  version: 2,
  taskId: 'fixture',
  scope: { workspaceRoot: '/original', projectRoot: '/original/app', state: 'resolved' },
  authority: { tools: 'full', edit: true, execute: 'approved', externalEffects: false },
  acceptanceCriteria: ['Return the requested artifact'],
  interpretation: {
    forbidsMutation: false,
    obligations: [{ id: 'one', text: 'Implement the requested fix' }],
    constraints: {
      edit: false,
      execution: false,
      verification: false,
      commit: true,
      external: true
    }
  }
})
describe('cloud contract authority', () => {
  it('preserves obligations and maps project paths without exposing sibling projects', () => {
    const task = parseCloudTask(contract())
    expect(scopePrefix(task)).toBe('app')
    expect(artifactPath(task, 'src/a.ts')).toBe('app/src/a.ts')
    expect(task.interpretation?.obligations[0]?.id).toBe('one')
    const invalid = contract()
    invalid.scope.projectRoot = '/other'
    expect(() => parseCloudTask(invalid)).toThrow('outside')
  })
  it('rejects unknown authority values and ambiguous scope before admission', () => {
    expect(() =>
      parseCloudTask({ ...contract(), authority: { ...contract().authority, tools: 'everything' } })
    ).toThrow()
    expect(() =>
      parseCloudTask({ ...contract(), scope: { ...contract().scope, state: 'ambiguous' } })
    ).toThrow('Resolve')
  })
  it('intersects edit, tool, execution and external ceilings', () => {
    const task = parseCloudTask(contract())
    expect(canEdit(task)).toBe(true)
    expect(() => assertExternal(task)).toThrow('forbids')
    task.interpretation!.constraints!.edit = true
    expect(() => assertTaskTool(task, 'write_file', { path: 'safe.ts' })).toThrow('forbids edits')
    task.authority.tools = 'read'
    expect(() => assertTaskTool(task, 'run', { command: 'npm test' })).toThrow('execution')
    expect(() => assertTaskTool(task, 'read_file', { path: '.git/config' })).toThrow('metadata')
    task.authority.tools = 'none'
    expect(() => assertTaskTool(task, 'tree', {})).toThrow('forbids tools')
  })
})
