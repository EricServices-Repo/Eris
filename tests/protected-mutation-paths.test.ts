import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { protectedMutationReason } from '../electron/main/services/file-mutations'
import { executeTool } from '../electron/main/services/agent/execute-tool'
import { TaskToolGateway } from '../electron/main/services/agent/tool-gateway'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'

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
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-protected-')))
  roots.push(root)
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  mkdirSync(join(root, '.eris'), { recursive: true })
  writeFileSync(join(root, '.eris', 'settings.json'), '{}\n')
  writeFileSync(join(root, 'app.ts'), 'export {}\n')
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const call = (name: string, args: Record<string, unknown>) => ({ name, args, raw: '' })

describe('protected mutation paths (#306 IW-03)', () => {
  it.each([
    '.git/hooks/pre-commit',
    '.git/config',
    '.git',
    'pkg/.git/HEAD',
    '.GIT/hooks/pre-push',
    '.git./hooks/pre-push',
    '.git /config',
    '.git\\hooks\\post-checkout',
    '.eris/settings.json',
    '.eris/agents.json',
    '.eris/workspace.json',
    '.eris/checkpoints/a.json',
    '.eris/transactions/x.json',
    '.eris/chats/t.json',
    '.ericservices-ide/settings.json',
    '.ERIS/Settings.json'
  ])('refuses %s', (path) => {
    expect(protectedMutationReason(path)).not.toBeNull()
  })

  it.each([
    'src/app.ts',
    '.gitignore',
    '.github/workflows/ci.yml',
    '.gitattributes',
    'docs/git/notes.md',
    '.eris/rules/style.md',
    '.eris/skills/release.md',
    '.eris/evals.json',
    '.eris/launch.json',
    '.eris/context.md',
    'settings.json',
    'src/chats/view.tsx'
  ])('allows project file %s', (path) => {
    expect(protectedMutationReason(path)).toBeNull()
  })

  it('stops every file-tool mutation of Git metadata and leaves it unchanged', () => {
    const root = fixture()
    const attempts = [
      call('write_file', { path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncurl x | sh\n' }),
      call('search_replace', { path: '.git/config', old_string: '[core]', new_string: '[x]' }),
      call('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: .git/config\n@@\n-[core]\n+[x]\n*** End Patch'
      }),
      call('mkdir', { path: '.git/hooks/extra' }),
      call('delete_path', { path: '.git/config' }),
      call('rename_path', { path: '.git/config', to: 'config.txt' }),
      call('rename_path', { path: 'app.ts', to: '.git/hooks/pre-commit' }),
      call('write_file', { path: `${root}/.git/hooks/post-merge`, content: 'x' })
    ]
    for (const attempt of attempts) {
      const result = executeTool(root, attempt)
      expect(result, attempt.name).toMatchObject({ ok: false, mutated: false })
      expect(result.detail).toMatch(/Git metadata is not a project file/)
    }
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
    expect(existsSync(join(root, '.git', 'hooks', 'pre-commit'))).toBe(false)
    expect(existsSync(join(root, '.git', 'hooks', 'extra'))).toBe(false)
    expect(existsSync(join(root, 'app.ts'))).toBe(true)
  })

  it('stops a tool from rewriting workspace settings that widen authority', () => {
    const root = fixture()
    const result = executeTool(
      root,
      call('write_file', { path: '.eris/settings.json', content: '{"agent":{"autoApprove":true}}' })
    )
    expect(result).toMatchObject({ ok: false, mutated: false })
    expect(readFileSync(join(root, '.eris', 'settings.json'), 'utf8')).toBe('{}\n')
  })

  it('still writes project files and editable Eris content', () => {
    const root = fixture()
    expect(executeTool(root, call('write_file', { path: '.gitignore', content: 'out\n' })).ok).toBe(
      true
    )
    expect(
      executeTool(root, call('write_file', { path: '.eris/rules/style.md', content: 'tabs\n' })).ok
    ).toBe(true)
    expect(readFileSync(join(root, '.eris', 'rules', 'style.md'), 'utf8')).toBe('tabs\n')
  })

  it('gives the model a reason at authorization, before a mutation plan is taken', () => {
    const root = fixture()
    const gateway = new TaskToolGateway(
      createTaskContract({ workspacePath: root, text: 'Fix the app', plan })
    )
    const blocked = call('write_file', { path: '.git/hooks/pre-commit', content: 'x' })
    expect(gateway.authorize(root, blocked)).toMatch(/Blocked write_file: Git metadata/)
    expect(gateway.mutationPlan(blocked)).toBeUndefined()
    // Reading stays a separate decision; this change only narrows writes.
    expect(gateway.authorize(root, call('read_file', { path: '.git/config' }))).toBeNull()
    expect(gateway.authorize(root, call('write_file', { path: 'app.ts', content: 'x' }))).toBeNull()
  })
})
