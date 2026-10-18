import { z } from 'zod'

export const ImageSizeSchema = z.enum([
  '512x512',
  '768x512',
  '512x768',
  '1024x1024',
  '1536x1024',
  '1024x1536'
])
export const ImageGenerationSettingsSchema = z.object({
  backend: z.enum(['api', 'local']).default('api'),
  enabled: z.boolean().default(false),
  connectionId: z.string().default(''),
  model: z.string().default(''),
  size: ImageSizeSchema.default('1024x1024'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto')
})
export const ImageGenerationRequestSchema = z
  .object({
    requestId: z.string().min(1).max(160),
    prompt: z.string().trim().min(1).max(16_000),
    size: ImageSizeSchema.optional()
  })
  .strict()
