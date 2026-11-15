export type LocalModelServiceId = 'ollama' | 'lmstudio'

export interface DetectedModelService {
  id: LocalModelServiceId
  name: string
  models: string[]
}

export interface ModelSetupOptions {
  services: DetectedModelService[]
  recommended: { id: string; name: string; sizeLabel: string } | null
}

export const CONNECT_MODEL_MESSAGE = 'Connect a model in Settings → Models to continue.'
