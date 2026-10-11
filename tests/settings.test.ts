import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { describe, expect, it } from 'vitest'
import { userSettingsPath } from '../electron/main/services/paths'
import { getDefaults, getResolvedSettings } from '../electron/main/services/settings'

function writeUserSettings(raw: unknown) {
  mkdirSync(dirname(userSettingsPath()), { recursive: true })
  writeFileSync(userSettingsPath(), JSON.stringify(raw))
}

describe('settings defaults', () => {
  it('default settings pass the schema and ask before agent commands', () => {
    const d = getDefaults()
    expect(d.agent.commandApproval).toBe('ask')
    expect(d.agent.allowedCommands).toEqual([])
    expect(d.models.defaultModel).toBe('builtin:composer-lite')
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
    // New keys missing from old files come from defaults
    expect(s.agent.commandApproval).toBe('ask')
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
})
