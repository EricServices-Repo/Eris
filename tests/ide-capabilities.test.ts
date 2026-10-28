import * as settingsService from '../electron/main/services/settings'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { languageCapabilities } from '../src/shared/ide-capabilities'
import {
  applyLanguageTextEdits,
  singleDocumentEdits,
  previewLanguageEdit,
  applyLanguageEdit
} from '../electron/main/services/language-edits'
import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'
import { DapSession } from '../electron/main/services/dap-session'
import { DapDebugger } from '../electron/main/services/dap-debugger'
import {
  listLaunchConfigs,
  saveLaunchConfigs,
  startDebug,
  stopDebug,
  getDebugState
} from '../electron/main/services/debug-service'
const edits = vi.hoisted(() => ({ response: [] as unknown }))
vi.mock('../electron/main/services/language-servers', () => ({
  lspDidChange: vi.fn(),
  negotiatedEditRequest: vi.fn(async () => ({ response: edits.response, version: 2 }))
}))
vi.mock('../electron/main/services/code-index', () => ({ notifyWorkspaceFilesChanged: vi.fn() }))
vi.mock('../electron/main/services/workspace-search', () => ({
  invalidateWorkspaceSearchCache: vi.fn()
}))
const roots: string[] = []
function root() {
  const p = mkdtempSync(join(tmpdir(), 'eris-capability-'))
  roots.push(p)
  return p
}
afterEach(() => {
  vi.useRealTimers()
  for (const p of roots.splice(0))
    rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const replacement = [
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'new' }
]
describe('negotiated language edits', () => {
  it('does not advertise missing, false or unready server capabilities', () => {
    expect(languageCapabilities('fixture', {}).formatting).toBe(false)
    expect(
      languageCapabilities('fixture', { renameProvider: { prepareProvider: true } }).rename
    ).toBe(true)
    expect(languageCapabilities('fixture', { renameProvider: true }, false).rename).toBe(false)
  })
  it('uses UTF-16 positions, preserves CRLF and rejects overlapping/outside edits', () => {
    expect(applyLanguageTextEdits('old\r\nnext', replacement)).toBe('new\r\nnext')
    expect(
      applyLanguageTextEdits('😀x', [
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
          newText: 'y'
        }
      ])
    ).toBe('😀y')
    expect(() => applyLanguageTextEdits('old', [...replacement, ...replacement])).toThrow(
      'Overlapping'
    )
    expect(() => applyLanguageTextEdits('a', replacement)).toThrow('outside')
  })
  it('refuses multi-file/resource changes and mismatched document versions', () => {
    const path = join(root(), 'a.ts'),
      uri = pathToFileURL(path).href
    expect(
      singleDocumentEdits(
        { documentChanges: [{ textDocument: { uri, version: 2 }, edits: replacement }] },
        path,
        2
      )
    ).toEqual(replacement)
    expect(() =>
      singleDocumentEdits(
        { documentChanges: [{ textDocument: { uri, version: 1 }, edits: replacement }] },
        path,
        2
      )
    ).toThrow('Stale')
    expect(() =>
      singleDocumentEdits(
        { changes: { [uri]: replacement, 'file:///outside.ts': replacement } },
        path,
        2
      )
    ).toThrow('Multi-file')
    expect(() =>
      singleDocumentEdits({ documentChanges: [{ kind: 'delete', uri }] }, path, 2)
    ).toThrow('Resource')
  })
  it('preserves dirty and raced disk changes; binds previews to owner, expiry, workspace and one confirmation', async () => {
    const workspace = root(),
      path = join(workspace, 'a.ts')
    writeFileSync(path, 'old')
    edits.response = replacement
    await expect(
      previewLanguageEdit(
        workspace,
        { path, text: 'dirty', kind: 'formatting', params: {} },
        1,
        () => true
      )
    ).rejects.toThrow('dirty')
    const input = { path, text: 'old', kind: 'formatting' as const, params: {} }
    const [preview] = await previewLanguageEdit(workspace, input, 1, () => true)
    await expect(applyLanguageEdit(workspace, preview.id!, 2, () => true)).rejects.toThrow('owner')
    writeFileSync(path, 'raced')
    await expect(applyLanguageEdit(workspace, preview.id!, 1, () => true)).rejects.toThrow(
      'changed'
    )
    expect(readFileSync(path, 'utf8')).toBe('raced')
    writeFileSync(path, 'old')
    const [fresh] = await previewLanguageEdit(workspace, input, 1, () => true)
    const result = await applyLanguageEdit(workspace, fresh.id!, 1, () => true)
    expect(result.content).toBe('new')
    expect(readFileSync(path, 'utf8')).toBe('new')
    await expect(applyLanguageEdit(workspace, fresh.id!, 1, () => true)).rejects.toThrow('expired')
    writeFileSync(path, 'old')
    const [expires] = await previewLanguageEdit(workspace, input, 1, () => true)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 130000)
    await expect(applyLanguageEdit(workspace, expires.id!, 1, () => true)).rejects.toThrow(
      'expired'
    )
  })
})
describe('debug adapter fixtures', () => {
  const fixture = resolve('tests/fixtures/dap-adapter.cjs')
  it('preserves unsupported launch configuration types and rejects them before process launch', async () => {
    const workspace = root()
    saveLaunchConfigs(workspace, [
      { id: 'python', name: 'unsupported', type: 'python', request: 'attach', program: '' }
    ])
    expect(listLaunchConfigs(workspace)[0]).toMatchObject({ type: 'python', request: 'attach' })
    await expect(
      startDebug({ workspacePath: workspace, config: listLaunchConfigs(workspace)[0] })
    ).rejects.toThrow('Unsupported')
  })
  it('retains real Node inspector launch and clean stop without an installed DAP adapter', async () => {
    const workspace = root(),
      path = join(workspace, 'node-fixture.cjs')
    writeFileSync(path, 'setInterval(()=>{},1000)')
    setWorkspaceTrusted(workspace, true)
    try {
      expect(
        await startDebug({
          workspacePath: workspace,
          config: {
            id: 'node',
            name: 'Node',
            type: 'node',
            request: 'launch',
            program: 'node-fixture.cjs'
          }
        })
      ).toMatchObject({ running: true })
      await expect(
        startDebug({
          workspacePath: workspace,
          config: {
            id: 'unsupported',
            name: 'unsupported',
            type: 'python',
            request: 'attach',
            program: ''
          }
        })
      ).rejects.toThrow('Unsupported')
      expect(getDebugState()).toMatchObject({ running: true, configId: 'node' })
    } finally {
      await stopDebug()
    }
  }, 20000)
  it('serializes replacement launches and cancels an initializing adapter without stopping the replacement', async () => {
    const workspace = root()
    writeFileSync(join(workspace, 'target.py'), 'print(1)')
    setWorkspaceTrusted(workspace, true)
    const mock = vi.spyOn(settingsService, 'getUserSettings').mockReturnValue({
      intelligence: {
        debugAdapters: [
          { id: 'slow', enabled: true, command: process.execPath, args: [fixture, 'silent'] },
          { id: 'ready', enabled: true, command: process.execPath, args: [fixture] }
        ]
      }
    })
    const slow = startDebug({
      workspacePath: workspace,
      config: {
        id: 'slow',
        name: 'slow',
        type: 'dap:slow',
        request: 'launch',
        program: 'target.py'
      }
    })
    const rejected = expect(slow).rejects.toThrow()
    try {
      await vi.waitFor(() =>
        expect(getDebugState()).toMatchObject({ configId: 'slow', running: true })
      )
      const ready = await startDebug({
        workspacePath: workspace,
        config: {
          id: 'ready',
          name: 'ready',
          type: 'dap:ready',
          request: 'launch',
          program: 'target.py'
        }
      })
      await rejected
      expect(ready).toMatchObject({ running: true, configId: 'ready' })
    } finally {
      await stopDebug()
      mock.mockRestore()
    }
  }, 20000)
  it('parses split frames and refuses reverse process requests', async () => {
    const session = new DapSession(
      root(),
      process.execPath,
      [fixture],
      () => {},
      () => {}
    )
    try {
      expect(await session.request('reverseProbe')).toMatchObject({ denied: true })
    } finally {
      await session.stop(true)
    }
  })
  it('terminates oversized frames and cancels bounded unanswered requests', async () => {
    for (const mode of ['malformed', 'silent']) {
      const session = new DapSession(
        root(),
        process.execPath,
        [fixture, mode],
        () => {},
        () => {}
      )
      try {
        await expect(session.request('initialize', {}, 100)).rejects.toThrow()
        expect(session.active).toBe(false)
      } finally {
        await session.stop(false)
      }
    }
  })
  it('negotiates launch, paused stack variables/watch/exception controls and stop using an independent stdio fixture', async () => {
    const workspace = root(),
      session = new DapDebugger(
        workspace,
        process.execPath,
        [fixture],
        {
          id: 'dap-test',
          name: 'fixture',
          type: 'dap:fixture',
          request: 'launch',
          program: fixture
        },
        () => {}
      )
    try {
      await session.start(workspace, fixture, [])
      await vi.waitFor(() => expect(session.state.callFrames?.length).toBe(1))
      expect(await session.variables()).toEqual([{ name: 'fixture', value: '42' }])
      expect(await session.evaluate('fixture')).toMatchObject({ result: 'fixture-result' })
      await session.exceptions(['uncaught'])
      await expect(session.exceptions(['unsupported'])).rejects.toThrow('advertised')
      await session.command('continue')
      await vi.waitFor(() => expect(session.state.paused).toBe(false))
    } finally {
      await session.stop()
    }
    expect(session.client.active).toBe(false)
  })
})
