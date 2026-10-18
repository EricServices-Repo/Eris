import { describe, expect, it } from 'vitest'
import {
  shouldIgnoreErisRel,
  shouldIgnoreWorkspaceRel
} from '../electron/main/services/workspace-watcher'

describe('workspace watcher ignore rules', () => {
  it.each([
    'node_modules/react/index.js',
    '.git/HEAD',
    'dist/mac/Eris.app',
    '.eris/code-index.json',
    '.eris/code-index.json.tmp',
    '.eris/chats/chats.sqlite-wal',
    '.ericservices-ide/chats/chats.sqlite',
    '.eris/cache/x.json',
    '.eris/checkpoints/abc/meta.json',
    '.eris/runs/last.json',
    'tsconfig.web.tsbuildinfo',
    '.DS_Store'
  ])('ignores %s', (rel) => {
    expect(shouldIgnoreWorkspaceRel(rel)).toBe(true)
  })

  it.each(['src/App.tsx', 'package.json', '.eris/settings.json', '.eris/skills/a/SKILL.md', '.env'])(
    'reports %s',
    (rel) => {
      expect(shouldIgnoreWorkspaceRel(rel)).toBe(false)
    }
  )

  it('only treats internal .eris files as noise', () => {
    expect(shouldIgnoreErisRel('.eris/rules/a.md')).toBe(false)
    expect(shouldIgnoreErisRel('src/code-index.json')).toBe(false)
  })
})
