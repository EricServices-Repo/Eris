import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, ModelInfo, ResolvedAgent } from '@/shared/settings-schema'

export function useModels(settings: AppSettings | null) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [ollamaOk, setOllamaOk] = useState(false)
  const [composerReady, setComposerReady] = useState(false)
  const [modelsKnown, setModelsKnown] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const refreshGeneration = useRef(0)
  const [agents, setAgents] = useState<ResolvedAgent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | 'auto'>('auto')

  useEffect(() => {
    const pin = settings?.agent.routing.pinnedAgentId
    if (!pin) return
    setSelectedAgentId(pin === 'auto' ? 'auto' : pin)
  }, [settings?.agent.routing.pinnedAgentId])

  const refreshModels = useCallback(
    async (resolved?: AppSettings) => {
      const generation = ++refreshGeneration.current
      // An unavailable project agent config must not hide installed models.
      void window.ide
        .listAgents()
        .then((list) => {
          if (generation === refreshGeneration.current) setAgents(list)
        })
        .catch(() => {})
      let status: Awaited<ReturnType<typeof window.ide.modelsStatus>>
      try {
        status = await window.ide.modelsStatus()
      } catch (error) {
        if (generation === refreshGeneration.current) {
          setModelsError(error instanceof Error ? error.message : String(error))
        }
        return // Preserve the last successful catalog; a probe failure is not an empty catalog.
      }
      if (generation !== refreshGeneration.current) return
      setModelsKnown(true)
      setModelsError(null)
      const builtinReady =
        status.models.some((m) => m.source === 'builtin' && m.ready) ||
        (status.builtin?.some((b) => b.ready) ?? false)
      const localReady =
        status.models.some((m) => m.source === 'local' && m.ready) ||
        (status.local?.some((m) => m.ready) ?? false)
      setComposerReady(builtinReady || localReady)
      setOllamaOk(
        builtinReady ||
          localReady ||
          Boolean(status.models.some((m) => m.source === 'connection' && m.ready))
      )
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
      const s = resolved ?? settings
      const liteReady = status.models.find(
        (m) => m.name === 'builtin:composer-lite' && m.ready
      )?.name
      const preferred =
        (s?.models.defaultModel === 'builtin:composer-lite' && liteReady) ||
        liteReady ||
        (s?.models.defaultModel &&
        s.models.defaultModel !== 'builtin:composer' &&
        status.models.some((m) => m.name === s.models.defaultModel && m.ready)
          ? s.models.defaultModel
          : null) ||
        status.models.find((m) => m.ready && m.source === 'connection')?.name ||
        status.models.find((m) => m.name.startsWith('builtin:') && m.ready)?.name ||
        status.models.find((m) => m.ready)?.name ||
        'builtin:composer-lite'
      setSelectedModel((prev) => {
        if (prev === 'auto' || s?.models.defaultModel === 'auto') return 'auto'
        if (prev === 'builtin:composer' || s?.models.defaultModel === 'builtin:composer') {
          return 'builtin:composer'
        }
        if (prev && status.models.some((m) => m.name === prev && m.ready === true)) {
          return prev
        }
        if (
          s?.models.defaultModel &&
          status.models.some((m) => m.name === s.models.defaultModel && m.ready === true)
        ) {
          return s.models.defaultModel
        }
        return preferred
      })
    },
    [settings]
  )

  return {
    models,
    modelsKnown,
    modelsError,
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
