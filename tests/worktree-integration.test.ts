import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeAgentBranch } from '../electron/main/services/worktrees'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'eris-integration-'))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('commit', '--allow-empty', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  git('checkout', '-b', 'fixture-work')
  git('commit', '--allow-empty', '-m', 'work')
  git('checkout', 'main')
  return { root, git, baseSha }
}
describe('worktree integration destination', () => {
  it('refuses branch switches and baseline changes without touching the checkout', async () => {
    const { root, git, baseSha } = fixture()
    git('checkout', '-b', 'unrelated')
    const before = git('rev-parse', 'HEAD')
    expect(await mergeAgentBranch(root, 'fixture-work', { branch: 'main', baseSha })).toMatchObject(
      { ok: false }
    )
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('unrelated')
    expect(git('rev-parse', 'HEAD')).toBe(before)
    git('checkout', 'main')
    git('commit', '--allow-empty', '-m', 'new destination change')
    expect(await mergeAgentBranch(root, 'fixture-work', { branch: 'main', baseSha })).toMatchObject(
      { ok: false }
    )
  })
  it('requires a clean destination and returns the integration commit receipt', async () => {
    const { root, git, baseSha } = fixture()
    writeFileSync(join(root, 'user-work.txt'), 'unsaved fixture work')
    expect(await mergeAgentBranch(root, 'fixture-work', { branch: 'main', baseSha })).toMatchObject(
      { ok: false }
    )
    rmSync(join(root, 'user-work.txt'))
    const merged = await mergeAgentBranch(root, 'fixture-work', { branch: 'main', baseSha })
    expect(merged).toMatchObject({ ok: true, commit: git('rev-parse', 'HEAD') })
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })
})
