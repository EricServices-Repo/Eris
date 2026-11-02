import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'
import { describe, expect, it } from 'vitest'
import { userSettingsPath, workspaceSettingsPath } from '../electron/main/services/paths'
import { McpServerSchema, SettingsSchema } from '../src/shared/settings-schema'
import {
  getDefaults,
  getResolvedSettings,
  invalidateResolvedSettingsCache,
  setSettings
} from '../electron/main/services/settings'

function writeUserSettings(raw: unknown) {
  mkdirSync(dirname(userSettingsPath()), { recursive: true })
  writeFileSync(userSettingsPath(), JSON.stringify(raw))
  invalidateResolvedSettingsCache()
}

describe('settings defaults', () => {
  it('fills image defaults when older settings omit the section', () => {
    const settings = SettingsSchema.parse({ ...getDefaults(), images: undefined })
    expect(settings.images).toEqual({
      backend: 'api',
      enabled: false,
      connectionId: '',
      model: '',
      size: '1024x1024',
      quality: 'auto'
    })
  })

  it('preserves MCP environment records while rejecting non-string values', () => {
    const server = {
      id: 'example',
      name: 'Example',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: [],
      url: '',
      env: { EXAMPLE_MODE: 'local' },
      notes: ''
    }
    expect(McpServerSchema.parse(server).env).toEqual({ EXAMPLE_MODE: 'local' })
    expect(McpServerSchema.safeParse({ ...server, env: { EXAMPLE_MODE: 7 } }).success).toBe(false)
  })

  it('default settings pass the schema and ask before agent commands', () => {
    const d = getDefaults()
    expect(d.agent.commandApproval).toBe('ask')
    expect(d.agent.allowedCommands).toEqual([])
    expect(d.models.defaultModel).toBe('builtin:composer-lite')
  })

  it('caches resolved settings until invalidated by a write', () => {
    writeUserSettings({ editor: { chatFont: 'serif' } })
    const a = getResolvedSettings(null)
    const b = getResolvedSettings(null)
    expect(a).toBe(b)
    expect(a.editor.chatFont).toBe('serif')
    setSettings('user', { editor: { chatFont: 'sans' } }, null)
    const c = getResolvedSettings(null)
    expect(c.editor.chatFont).toBe('sans')
    expect(c).not.toBe(a)
  })
})

describe('settings migrations', () => {
  it('upgrades legacy user settings', () => {
    writeUserSettings({
      models: { provider: 'ollama', ollama: { host: 'http://x' }, defaultModel: '' },
      agent: { routing: { fallbackAgentId: 'orchestrator', routerModel: '' }, subagents: [] },
      general: { logging: { level: 'verbose' } },
      editor: {}
    })
    const s = getResolvedSettings(null)
    const models = s.models as Record<string, unknown>
    expect(models.provider).toBeUndefined()
    expect(models.ollama).toBeUndefined()
    expect(s.models.defaultModel).toBe('builtin:composer-lite')
    expect(s.agent.routing.fallbackAgentId).toBe('composer')
    expect(s.agent.routing.routerModel).toBe('builtin:composer-lite')
    expect((s.agent as Record<string, unknown>).subagents).toBeUndefined()
    expect(s.general.logging.level).toBe('info')
    expect(s.editor.inlineSuggest).toBe(true)
    expect(s.editor.chatFont).toBe('mono')
    // New keys missing from old files come from defaults
    expect(s.agent.commandApproval).toBe('ask')
  })

  it('accepts chat response font choices', () => {
    writeUserSettings({ editor: { chatFont: 'serif' } })
    expect(getResolvedSettings(null).editor.chatFont).toBe('serif')
    writeUserSettings({ editor: { chatFont: 'sans' } })
    expect(getResolvedSettings(null).editor.chatFont).toBe('sans')
  })

  it('ensures builtin connections list both Composer tiers', () => {
    writeUserSettings({
      models: {
        connections: [
          {
            id: 'builtin',
            name: 'B',
            type: 'builtin',
            enabled: true,
            baseUrl: '',
            apiKeyRef: '',
            models: []
          },
          {
            id: 'o',
            name: 'Ollama',
            type: 'openai-compatible',
            enabled: true,
            baseUrl: 'http://localhost:11434/v1',
            apiKeyRef: '',
            models: ['qwen3']
          }
        ]
      }
    })
    const s = getResolvedSettings(null)
    const builtin = s.models.connections.find((c) => c.id === 'builtin')!
    expect(builtin.models).toEqual(
      expect.arrayContaining(['builtin:composer-lite', 'builtin:composer'])
    )
    expect(s.models.connections.find((c) => c.id === 'o')!.provider).toBe('custom')
  })

  it('coerces legacy connection type openai to openai-compatible', () => {
    writeUserSettings({
      models: {
        connections: [
          {
            id: 'builtin',
            name: 'B',
            type: 'builtin',
            enabled: true,
            baseUrl: '',
            apiKeyRef: '',
            models: []
          },
          {
            id: 'oa',
            name: 'OpenAI',
            type: 'openai',
            enabled: true,
            baseUrl: 'https://api.openai.com/v1',
            apiKeyRef: '',
            models: ['gpt-4o']
          }
        ]
      }
    })
    const s = getResolvedSettings(null)
    const oa = s.models.connections.find((c) => c.id === 'oa')!
    expect(oa.type).toBe('openai-compatible')
    expect(oa.provider).toBe('openai')
  })

  it('persists legacy connection type migration to disk', async () => {
    const { migrateLegacyConnectionTypesInUserSettings } =
      await import('../electron/main/services/settings')
    const { readFileSync } = await import('fs')
    const { userSettingsPath } = await import('../electron/main/services/paths')
    writeUserSettings({
      models: {
        connections: [
          {
            id: 'ollama',
            name: 'Ollama',
            type: 'openai',
            provider: 'ollama',
            enabled: true,
            baseUrl: 'http://localhost:11434/v1',
            apiKeyRef: '',
            models: ['qwen3']
          }
        ]
      }
    })
    migrateLegacyConnectionTypesInUserSettings()
    const disk = JSON.parse(readFileSync(userSettingsPath(), 'utf8')) as {
      models: { connections: Array<{ type: string; provider: string }> }
    }
    expect(disk.models.connections[0]!.type).toBe('openai-compatible')
    expect(disk.models.connections[0]!.provider).toBe('ollama')
  })
})

describe('RAM-CTX-034 user-owned remote recall ceiling', () => {
  const workspace = (share?: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'eris-recall-ceiling-'))
    mkdirSync(dirname(workspaceSettingsPath(root)), { recursive: true })
    writeFileSync(
      workspaceSettingsPath(root),
      JSON.stringify({ agent: { contextMemory: { shareWithRemoteModels: share } } })
    )
    return root
  }
  it.each([false, true])(
    'a workspace cannot raise the absent/false user ceiling, trusted=%s',
    (trusted) => {
      const root = workspace(true)
      setWorkspaceTrusted(root, trusted)
      for (const value of [undefined, false]) {
        writeUserSettings({ agent: { contextMemory: { shareWithRemoteModels: value } } })
        expect(getResolvedSettings(root).agent.contextMemory.shareWithRemoteModels).toBe(false)
      }
    }
  )
  it.each([false, true])(
    'explicit profile opt-in works and repositories can only restrict it, trusted=%s',
    (trusted) => {
      for (const [preference, expected] of [
        [undefined, true],
        [true, true],
        [false, false]
      ] as const) {
        const root = workspace(preference)
        setWorkspaceTrusted(root, trusted)
        writeUserSettings({ agent: { contextMemory: { shareWithRemoteModels: true } } })
        expect(getResolvedSettings(root).agent.contextMemory.shareWithRemoteModels).toBe(expected)
      }
    }
  )
  it('uses the same ceiling after imported profile data, reset, and workspace UI writes', () => {
    const root = workspace(true)
    setWorkspaceTrusted(root, true)
    writeUserSettings({ agent: { contextMemory: { shareWithRemoteModels: 'true' } } })
    expect(getResolvedSettings(root).agent.contextMemory.shareWithRemoteModels).toBe(false)
    setSettings('user', { agent: { contextMemory: { shareWithRemoteModels: true } } }, root)
    expect(getResolvedSettings(root).agent.contextMemory.shareWithRemoteModels).toBe(true)
    setSettings('user', { agent: { contextMemory: { shareWithRemoteModels: false } } }, root)
    expect(
      setSettings('workspace', { agent: { contextMemory: { shareWithRemoteModels: true } } }, root)
        .agent.contextMemory.shareWithRemoteModels
    ).toBe(false)
  })
})

describe('RAM-CTX-055 RAM tier sizing mode', () => {
  const resolved = (saved: Record<string, unknown>) => {
    writeUserSettings({ agent: { contextMemory: saved } })
    return getResolvedSettings(null).agent.contextMemory
  }

  it('defaults to automatic, including for a saved default budget', () => {
    expect(getDefaults().agent.contextMemory.mode).toBe('auto')
    expect(resolved({ maxMemoryMiB: 128, maxThreadMiB: 32 }).mode).toBe('auto')
  })

  it('keeps a budget chosen before automatic sizing existed', () => {
    expect(resolved({ maxMemoryMiB: 512 })).toMatchObject({ mode: 'manual', maxMemoryMiB: 512 })
    expect(resolved({ maxThreadMiB: 64 }).mode).toBe('manual')
  })

  it('lets the user return to automatic without losing the saved budget', () => {
    expect(resolved({ mode: 'auto', maxMemoryMiB: 512 })).toMatchObject({
      mode: 'auto',
      maxMemoryMiB: 512
    })
  })

  it('accepts the raised manual ceiling and nothing past it', () => {
    expect(resolved({ mode: 'manual', maxMemoryMiB: 1024 }).maxMemoryMiB).toBe(1024)
    expect(resolved({ mode: 'manual', maxMemoryMiB: 1025 }).maxMemoryMiB).toBe(128)
  })
})
