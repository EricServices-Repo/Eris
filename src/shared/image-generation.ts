import type { z } from 'zod'
import type {
  ImageGenerationRequestSchema,
  ImageGenerationSettingsSchema
} from './image-generation-schema'

export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>
export type ImageGenerationSettings = z.infer<typeof ImageGenerationSettingsSchema>
export interface GeneratedImageAsset {
  id: string
  kind: 'image'
  mimeType: 'image/png'
  width: number
  height: number
  bytes: number
  provider: string
  model: string
  prompt: string
  revisedPrompt?: string
  createdAt: number
  /** Optional destination in the workspace. Original bytes stay in managed media. */
  path?: string
}
export type ImageGenerationProgress = {
  requestId: string
  stage: 'generating' | 'saving' | 'complete'
  detail?: string
}
export type ImageGenerationResult =
  { ok: true; asset: GeneratedImageAsset } | { ok: false; error: string; aborted?: boolean }

export function imageAssetUrl(id: string): string {
  return `eris-media://image/${encodeURIComponent(id)}`
}

/** Explicit chat command avoids guessing whether a user wants code or a picture. */
export function imagePromptFromCommand(text: string): string | null {
  const match = text.match(/^\/image(?:\s+([\s\S]*))?$/i)
  return match ? (match[1] ?? '').trim() : null
}

/** Only artwork requests, avoiding code questions about image loading/components. */
export function asksForImageGeneration(text: string): boolean {
  return /\b(?:generate|create|draw|design|make)\s+(?:(?:me|a|an|the|some|new|custom|hero)\s+){0,4}(?:image|picture|illustration|artwork|logo|icon|background|banner)s?\b/i.test(
    text
  )
}

export interface LocalImageModel {
  id: string
  repoId: string
  revision: string
  pipeline: string
  variant: string | null
  bytes: number
  downloadedAt: number
  ready: boolean
}
export interface LocalImageStatus {
  runtime: {
    ready: boolean
    device?: string
    deviceName?: string
    error?: string
    setup?: {
      operation: 'setup' | 'download'
      phase: string
      message: string
      code?: string
      updatedAt: number
      dependencySet: string
    }
    provenance?: Record<string, unknown>
  }
  models: LocalImageModel[]
  activeModelId: string | null
}
export interface LocalImageProgress {
  operation: 'setup' | 'download' | 'generate'
  message: string
  repoId?: string
  completed?: number
  total?: number
  unit?: string
}
