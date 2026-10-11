import { useCallback, useState } from 'react'
import type { AppSettings, ModelInfo, ResolvedAgent } from '@/shared/settings-schema'

export function useModels(settings: AppSettings | null) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [ollamaOk, setOllamaOk] = useState(false)
  const [composerReady, setComposerReady] = useState(false)
  const [agents, setAgents] = useState<ResolvedAgent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | 'auto'>('auto')

  const refreshModels = useCallback(async (resolved?: AppSettings) => {
    const [status, agentList] = await Promise.all([
      window.ide.modelsStatus(),
      window.ide.listAgents()
    ])
    const builtinReady = status.builtin?.some((b) => b.ready) ?? false
    setComposerReady(builtinReady)
    setOllamaOk(builtinReady || Boolean(status.models.some((m) => m.source === 'connection' && m.ready)))
    setModels(
      status.models.length > 0
        ? status.models
        : [
            {
              name: 'builtin:composer-lite',
              source: 'builtin' as const,
              ready: status.builtin?.some((b) => b.id === 'composer-lite' && b.ready) ?? false
            }
          ]
    )
    setAgents(agentList)
    const s = resolved ?? settings
    const preferred =
      s?.models.defaultModel ||
      status.models.find((m) => m.ready && m.source === 'connection')?.name ||
      status.models.find((m) => m.name === 'builtin:composer-lite' && m.ready)?.name ||
      status.models.find((m) => m.name.startsWith('builtin:') && m.ready)?.name ||
      status.models.find((m) => m.ready)?.name ||
      'builtin:composer-lite'
    setSelectedModel((prev) => {
      // Keep the session picker; only fill when empty or the prior model left the catalog.
      if (prev && status.models.some((m) => m.name === prev)) return prev
      if (s?.models.defaultModel && status.models.some((m) => m.name === s.models.defaultModel)) {
        return s.models.defaultModel
      }
      return preferred
    })
  }, [settings])

  return {
    models,
    selectedModel,
    setSelectedModel,
    ollamaOk,
    setOllamaOk,
    composerReady,
    setComposerReady,
    agents,
    selectedAgentId,
    setSelectedAgentId,
    refreshModels
  }
}
