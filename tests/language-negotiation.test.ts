import { describe, it, expect } from 'vitest'
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { getDefaults } from '../electron/main/services/settings'
import {
  configureLanguageServers,
  disposeLanguageServers,
  lspDidOpen,
  negotiatedLanguageCapabilities,
  negotiatedEditRequest
} from '../electron/main/services/language-servers'
import { isTsLike } from '../electron/main/services/ts-lsp'
describe('real language adapter negotiation', () => {
  it('routes a non-TS language to its configured adapter and refuses unadvertised requests', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-language-'))),
      path = join(root, 'test.py'),
      settings = getDefaults()
    writeFileSync(path, 'value = 1\n')
    settings.intelligence.languageServers = [
      {
        id: 'fixture-python',
        name: 'Fixture Python',
        enabled: true,
        languageId: 'python',
        extensions: ['py'],
        command: process.execPath,
        args: [resolve('tests/fixtures/lsp-capability.cjs')]
      }
    ]
    configureLanguageServers(settings, root)
    try {
      expect(isTsLike('', path)).toBe(false)
      await lspDidOpen(root, path, 'python', 'value = 1\n')
      expect(await negotiatedLanguageCapabilities(root, path)).toMatchObject({
        ready: true,
        adapter: 'fixture-python',
        formatting: true,
        rename: false,
        hover: false
      })
      await expect(
        negotiatedEditRequest(root, path, 'rename', { newName: 'renamed' })
      ).rejects.toThrow('advertise')
      expect(
        await negotiatedEditRequest(root, path, 'formatting', {
          options: { tabSize: 2, insertSpaces: true }
        })
      ).toMatchObject({ response: [], version: 1 })
    } finally {
      await disposeLanguageServers()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
  it('negotiates the bundled TypeScript adapter against a real source document', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-typescript-'))),
      path = join(root, 'source.ts')
    writeFileSync(path, 'const original = 1\nconsole.log(original)\n')
    configureLanguageServers(getDefaults(), root)
    try {
      await lspDidOpen(root, path, 'typescript', 'const original = 1\nconsole.log(original)\n')
      expect(await negotiatedLanguageCapabilities(root, path)).toMatchObject({
        ready: true,
        formatting: true,
        rename: true
      })
      const edit = await negotiatedEditRequest(root, path, 'rename', {
        position: { line: 0, character: 7 },
        newName: 'changed'
      })
      expect(JSON.stringify(edit.response)).toContain('changed')
    } finally {
      await disposeLanguageServers()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
})
