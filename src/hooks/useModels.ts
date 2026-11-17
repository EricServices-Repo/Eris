import { isAutomaticModelSelection } from '@/shared/model-execution'
import { isErisCloudModelRef } from '@/shared/eris-cloud'
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
        status = await window.ide.modelsStatus({ probeCloud: true })
      } catch (error) {
        if (generation === refreshGeneration.current) {
          setModelsError(error instanceof Error ? error.message : String(error))
        }
        return // Preserve the last successful catalog; a probe failure is not an empty catalog.
      }
      if (generation !== refreshGeneration.current) return
      setModelsKnown(true)
      setModelsError(null)
      const ready = status.models.filter((model) => model.source !== 'builtin')
      setComposerReady(ready.some((model) => model.source === 'local' && model.ready))
      setOllamaOk(ready.some((model) => model.ready))
      setModels(ready)
      const s = resolved ?? settings
      setSelectedModel((prev) => {
        const desired = prev || s?.models.defaultModel || 'auto'
        if (desired.startsWith('builtin:')) return 'auto-local'
        if (isErisCloudModelRef(desired) && !ready.some((model) => model.name === desired && model.ready))
          return 'auto-local'
        if (isAutomaticModelSelection(desired)) return desired
        return desired
      })
    },
    [settings]
  )

  useEffect(() => {
    const refresh = () => { void refreshModels() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refreshModels])

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
