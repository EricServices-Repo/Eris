import { describe, expect, it } from 'vitest'
import {
  buildSyncableSettings,
  mergePulledUserSettings
} from '../electron/main/services/ericservices'
import { getDefaults } from '../electron/main/services/settings'
import type { AppSettings } from '../src/shared/settings-schema'

function withExtras(base: AppSettings): AppSettings {
  return {
    ...base,
    models: {
      ...base.models,
      preferEgpu: false,
      connections: [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai-compatible',
          provider: 'openai',
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          apiKeyRef: 'openai-key',
          models: ['gpt-4o']
        },
        ...base.models.connections
      ]
    },
    agent: {
      ...base.agent,
      commandApproval: 'auto',
      allowedCommands: ['npm test'],
      constrainLocalToolCalls: false
    },
    general: {
      ...base.general,
      updates: { autoCheck: false, autoDownload: false, channel: 'beta' },
      logging: { enabled: true, directory: '/tmp/eris-logs', level: 'debug' },
      telemetry: { agentOutcomes: true }
    },
    evals: {
      useScoresForRouting: false,
      minRuns: 5,
      allowUnsafeCommands: true
    },
    backgroundAgents: { maxParallel: 3, linkNodeModules: false },
    intelligence: {
      embeddingProvider: 'connection',
      embeddingModel: 'nomic-embed-text',
      languageServers: [
        {
          id: 'python',
          name: 'Python',
          enabled: false,
          languageId: 'python',
          extensions: ['py'],
          command: 'pyright-langserver',
          args: ['--stdio']
        }
      ]
    },
    mcp: {
      servers: [
        {
          id: 'fs',
          name: 'FS',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'server'],
          url: '',
          env: { TOKEN: 'secret-value' },
          notes: ''
        }
      ]
    },
    github: {
      ...base.github,
      host: 'github.example.com',
      preferredProtocol: 'ssh',
      remoteName: 'upstream',
      defaultBranch: 'develop',
      tokenRef: 'gh-token',
      repository: 'acme/app',
      linked: true
    },
    editor: {
      ...base.editor,
      chatFont: 'serif',
      fontSize: 16
    }
  }
}

describe('buildSyncableSettings', () => {
  it('includes portable preferences and strips secrets / machine-only fields', () => {
    const sync = buildSyncableSettings(withExtras(getDefaults()))

    expect(sync.editor?.chatFont).toBe('serif')
    expect(sync.editor?.fontSize).toBe(16)
    expect(sync.general?.updates?.channel).toBe('beta')
    expect(sync.general?.updates?.autoCheck).toBe(false)
    expect(sync.general?.telemetry?.agentOutcomes).toBe(true)
    expect(sync.general?.logging).toEqual({ enabled: true, level: 'debug' })
    expect(sync.general?.logging && 'directory' in sync.general.logging).toBe(false)

    expect(sync.agent?.commandApproval).toBe('auto')
    expect(sync.agent?.allowedCommands).toEqual(['npm test'])
    expect(sync.agent?.constrainLocalToolCalls).toBe(false)

    expect(sync.models?.preferEgpu).toBe(false)
    const openai = sync.models?.connections?.find((c) => c?.id === 'openai')
    expect(openai?.apiKeyRef).toBe('')
    expect(openai?.baseUrl).toBe('https://api.openai.com/v1')

    expect(sync.intelligence?.embeddingModel).toBe('nomic-embed-text')
    expect(sync.intelligence?.languageServers?.[0]?.enabled).toBe(false)

    expect(sync.evals).toEqual({ useScoresForRouting: false, minRuns: 5 })
    expect(sync.evals && 'allowUnsafeCommands' in sync.evals).toBe(false)

    expect(sync.backgroundAgents).toEqual({ maxParallel: 3, linkNodeModules: false })

    expect(sync.mcp?.servers?.[0]?.env).toEqual({ TOKEN: '' })

    expect(sync.github).toEqual({
      host: 'github.example.com',
      preferredProtocol: 'ssh',
      remoteName: 'upstream',
      defaultBranch: 'develop'
    })
    expect(sync.github && 'tokenRef' in sync.github).toBe(false)
    expect(sync.github && 'repository' in sync.github).toBe(false)
    expect((sync as { ericServices?: unknown }).ericServices).toBeUndefined()
  })
})

describe('mergePulledUserSettings', () => {
  it('rehydrates api keys, MCP env, and empty language-server commands from local', () => {
    const local = withExtras(getDefaults())
    const remote = buildSyncableSettings(local)
    // Simulate empty LS command from an older client
    remote.intelligence = {
      ...remote.intelligence!,
      languageServers: [
        {
          id: 'python',
          name: 'Python',
          enabled: true,
          languageId: 'python',
          extensions: ['py'],
          command: '',
          args: []
        }
      ]
    }

    const merged = mergePulledUserSettings(remote, local)
    const openai = merged.models?.connections?.find((c) => c?.id === 'openai')
    expect(openai?.apiKeyRef).toBe('openai-key')
    expect(merged.mcp?.servers?.[0]?.env?.TOKEN).toBe('secret-value')
    expect(merged.intelligence?.languageServers?.[0]?.command).toBe('pyright-langserver')
    expect(merged.intelligence?.languageServers?.[0]?.args).toEqual(['--stdio'])
    expect(merged.github && 'repository' in merged.github).toBe(false)
    expect(merged.evals && 'allowUnsafeCommands' in merged.evals).toBe(false)
  })
})
