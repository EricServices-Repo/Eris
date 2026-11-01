import { z } from 'zod'
export const DevMemoryModeSchema = z.enum(['independent', 'stateful', 'pressure'])
export type DevMemoryMode = z.infer<typeof DevMemoryModeSchema>
export const DevMemoryCaseSchema = z
  .object({
    expectedSourceIds: z.array(z.string().min(1).max(256)).max(32).default([]),
    scriptedResponse: z.string().max(32000).optional(),
    rewindMessages: z.number().int().min(0).max(20000).optional(),
    forgottenSourceIds: z.array(z.string().min(1).max(256)).max(1000).optional()
  })
  .strict()
export type DevMemoryTrace = {
  version: 1
  episode: string
  mode: DevMemoryMode
  revision: number
  controlsRevision: number
  policyDigest: string
  expectedSourceIds: string[]
  retrievedSourceIds: string[]
  sentSourceDigests: string[]
  missingExpectedSourceIds: string[]
  selectionMs: number
  estimatedBytes: number
  estimatedTokens: number
  actualModelCalls: number
  pressureInjected: boolean
  /** The store lost this thread during the turn with no injected pressure. Gate: 0. */
  storeWiped: boolean
  rawContent: 'in-existing-request-capture-only'
}
