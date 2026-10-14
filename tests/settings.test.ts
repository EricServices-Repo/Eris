import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { describe, expect, it } from 'vitest'
import { userSettingsPath } from '../electron/main/services/paths'
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
          { id: 'builtin', name: 'B', type: 'builtin', enabled: true, baseUrl: '', apiKeyRef: '', models: [] },
          { id: 'o', name: 'Ollama', type: 'openai-compatible', enabled: true, baseUrl: 'http://localhost:11434/v1', apiKeyRef: '', models: ['qwen3'] }
        ]
      }
    })
    const s = getResolvedSettings(null)
    const builtin = s.models.connections.find((c) => c.id === 'builtin')!
    expect(builtin.models).toEqual(expect.arrayContaining(['builtin:composer-lite', 'builtin:composer']))
    expect(s.models.connections.find((c) => c.id === 'o')!.provider).toBe('custom')
  })

  it('coerces legacy connection type openai to openai-compatible', () => {
    writeUserSettings({
      models: {
        connections: [
          { id: 'builtin', name: 'B', type: 'builtin', enabled: true, baseUrl: '', apiKeyRef: '', models: [] },
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
    const { migrateLegacyConnectionTypesInUserSettings } = await import(
      '../electron/main/services/settings'
    )
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
