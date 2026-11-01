import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

const paths = vi.hoisted(() => ({ root: '' }))
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<typeof import('../electron/main/services/paths')>()),
  userDataRoot: () => paths.root,
  userSettingsPath: () => `${paths.root}/settings.json`,
  workspaceSettingsPath: (workspace: string) => `${workspace}/.eris/settings.json`
}))

import { memoryForDestination } from '../electron/main/services/agent/context-compiler'
import { modelDestination } from '../electron/main/services/model-destination'
import { streamOpenAICompatible } from '../electron/main/services/openai-compatible'
import {
  getResolvedSettings,
  invalidateResolvedSettingsCache
} from '../electron/main/services/settings'
import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'
import { destinationLabel, isLoopbackUrl, isNativeGgufRef } from '../src/shared/model-destination'
import type { AppSettings, ModelConnection } from '../src/shared/settings-schema'

const connection = (over: Partial<ModelConnection>): ModelConnection => ({
  id: 'c',
  name: 'Server',
  type: 'openai-compatible',
  provider: 'custom',
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKeyRef: '',
  models: ['m'],
  ...over
})
const settingsWith = (...connections: ModelConnection[]) =>
  ({
    models: { connections },
    agent: { contextMemory: { shareWithRemoteModels: false } }
  }) as unknown as AppSettings
const prompt = { text: 'older history', allowRemote: false } as never

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/v1',
    'http://127.1.2.3:1234',
    'http://localhost:1234/v1',
    'HTTP://LOCALHOST:1234',
    'http://[::1]:11434',
    'https://localhost'
  ])('accepts %s', (url) => expect(isLoopbackUrl(url)).toBe(true))

  it.each([
    'http://localhost.example.com:11434',
    'http://127.0.0.1.example.com',
    'http://localhost@evil.test',
    'http://127.0.0.1:11434@evil.test',
    'http://user:pass@localhost:11434',
    'http://evil.test/localhost',
    'http://evil.test#@localhost',
    'http://192.168.1.20:11434',
    'http://10.0.0.5:11434',
    'http://0.0.0.0:11434',
    'http://[::ffff:c0a8:101]:11434',
    'ftp://localhost',
    'file:///etc/passwd',
    'localhost:11434',
    'not a url',
    ''
  ])('refuses %s', (url) => expect(isLoopbackUrl(url)).toBe(false))

  it('sees through the numeric spellings fetch would also normalize', () => {
    expect(isLoopbackUrl('http://2130706433:11434')).toBe(true)
    expect(isLoopbackUrl('http://0x7f.1:11434')).toBe(true)
    expect(isLoopbackUrl('http://3232235777:11434')).toBe(false) // 192.168.1.1
  })
})

describe('modelDestination', () => {
  it('classifies native refs without looking at connections', () => {
    expect(isNativeGgufRef('builtin:x')).toBe(true)
    expect(modelDestination(settingsWith(), 'builtin:x')).toEqual({
      locality: 'in-process',
      recallAllowed: true
    })
  })

  it('gives a loopback server recall without the remote ceiling', () => {
    const settings = settingsWith(connection({ baseUrl: 'http://127.0.0.1:11434' }))
    expect(settings.agent.contextMemory.shareWithRemoteModels).toBeFalsy()
    expect(modelDestination(settings, 'm')).toEqual({ locality: 'loopback', recallAllowed: true })
    expect(memoryForDestination(prompt, 'm', settings)).toMatchObject({
      memory: 'older history',
      memoryBlocked: false
    })
  })

  it('never trusts a name or provider label on a public host', () => {
    const settings = settingsWith(
      connection({ id: 'local', name: 'local', provider: 'ollama', baseUrl: 'https://local.test' })
    )
    expect(modelDestination(settings, 'm')).toEqual({ locality: 'remote', recallAllowed: false })
    expect(memoryForDestination(prompt, 'm', settings)).toMatchObject({
      memory: undefined,
      memoryBlocked: true
    })
  })

  it('stays remote when no connection can be resolved', () => {
    expect(modelDestination(settingsWith(), 'unknown').recallAllowed).toBe(false)
  })

  it('judges the connection the transport picks, not any connection with that model', () => {
    const settings = settingsWith(
      connection({ id: 'cloud', baseUrl: 'https://api.example.com', models: ['m'] }),
      connection({ id: 'box', baseUrl: 'http://localhost:1234', models: ['m'] })
    )
    expect(modelDestination(settings, 'm').locality).toBe('remote')
  })

  it('blocks recall when no settings are supplied', () => {
    expect(memoryForDestination(prompt, 'm').memoryBlocked).toBe(true)
  })

  it('keeps LAN hosts remote until that exact URL is approved', () => {
    const baseUrl = 'http://192.168.1.20:11434'
    expect(modelDestination(settingsWith(connection({ baseUrl })), 'm').recallAllowed).toBe(false)
    const approved = connection({ baseUrl, recallApprovedUrl: baseUrl })
    expect(modelDestination(settingsWith(approved), 'm')).toEqual({
      locality: 'remote',
      recallAllowed: true
    })
    const moved = { ...approved, baseUrl: 'http://192.168.1.21:11434' }
    expect(modelDestination(settingsWith(moved), 'm').recallAllowed).toBe(false)
  })

  it('labels each locality for the inspector', () => {
    expect(destinationLabel('in-process')).toBe('local')
    expect(destinationLabel('loopback')).toBe('loopback')
    expect(destinationLabel('remote')).toBe('remote')
  })
})

describe('recall approval ownership', () => {
  const lan = 'http://192.168.1.20:11434'
  let workspace: string
  beforeEach(() => {
    paths.root = mkdtempSync(join(tmpdir(), 'eris-destination-'))
    workspace = join(paths.root, 'repo')
    mkdirSync(join(workspace, '.eris'), { recursive: true })
    invalidateResolvedSettingsCache()
  })
  afterEach(() => {
    invalidateResolvedSettingsCache()
    rmSync(paths.root, { recursive: true, force: true })
  })
  const write = (path: string, connections: ModelConnection[]) =>
    writeFileSync(path, JSON.stringify({ models: { connections } }))
  const workspaceFile = () => join(workspace, '.eris/settings.json')

  it('is honoured from the user profile', () => {
    write(join(paths.root, 'settings.json'), [connection({ baseUrl: lan, recallApprovedUrl: lan })])
    expect(modelDestination(getResolvedSettings(null), 'm').recallAllowed).toBe(true)
  })

  it('is ignored from a workspace, even a trusted one', () => {
    write(workspaceFile(), [connection({ baseUrl: lan, recallApprovedUrl: lan })])
    expect(modelDestination(getResolvedSettings(workspace), 'm').recallAllowed).toBe(false)
    setWorkspaceTrusted(workspace, true)
    invalidateResolvedSettingsCache()
    const resolved = getResolvedSettings(workspace)
    expect(resolved.models.connections.find((item) => item.id === 'c')?.baseUrl).toBe(lan)
    expect(modelDestination(resolved, 'm').recallAllowed).toBe(false)
  })

  it('cannot be reused by a workspace that repoints the approved connection', () => {
    write(join(paths.root, 'settings.json'), [connection({ baseUrl: lan, recallApprovedUrl: lan })])
    write(workspaceFile(), [
      connection({ baseUrl: 'https://evil.test', recallApprovedUrl: 'https://evil.test' })
    ])
    setWorkspaceTrusted(workspace, true)
    invalidateResolvedSettingsCache()
    expect(modelDestination(getResolvedSettings(workspace), 'm').recallAllowed).toBe(false)
  })
})

describe('redirect refusal', () => {
  let target: Server
  let local: Server
  const bodies: string[] = []
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    )
  beforeEach(() => {
    bodies.length = 0
  })
  afterEach(() => {
    target?.close()
    local?.close()
  })

  const drain = async (refuseRedirects: boolean, port: number) => {
    const chunks: string[] = []
    for await (const chunk of streamOpenAICompatible({
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'm',
      messages: [{ role: 'user', content: 'secret history' }],
      temperature: 0,
      refuseRedirects
    }))
      chunks.push(chunk)
    return chunks
  }

  it('never forwards a recall-bearing request off the approved host', async () => {
    target = createServer((request, response) => {
      request.on('data', (chunk) => bodies.push(String(chunk)))
      request.on('end', () => {
        response.setHeader('Content-Type', 'text/event-stream')
        response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
      })
    })
    const targetPort = await listen(target)
    local = createServer((_request, response) => {
      response.statusCode = 307
      response.setHeader('Location', `http://127.0.0.1:${targetPort}/v1/chat/completions`)
      response.end()
    })
    const port = await listen(local)
    await expect(drain(true, port)).rejects.toThrow()
    expect(bodies).toEqual([])
    // The control proves the fixture redirects; without refusal the body does move.
    await expect(drain(false, port)).resolves.toEqual(['ok'])
    expect(bodies.join('')).toContain('secret history')
  })
})
