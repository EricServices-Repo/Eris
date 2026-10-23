import { AsyncLocalStorage } from 'async_hooks'
import type { BlockedEffectKind } from '../../../src/shared/debug-runs'
import type { AppSettings } from '../../../src/shared/settings-schema'
import type { StreamModelChatOptions } from './chat-runtime'

/**
 * Model transport boundary shared by chat, routing, intent resolution, outcome
 * review, and the agent loop. Production calls reach providers; diagnostics
 * runs install a scoped adapter here instead of mocking the code under test.
 */
export type ModelPurpose = 'agent' | 'route' | 'intent' | 'outcome' | 'inline'

export type ModelTransportRequest = StreamModelChatOptions & { purpose: ModelPurpose }

export interface ModelAdapter {
  /** scripted adapters never reach a provider; live adapters always do. */
  readonly kind: 'scripted' | 'live'
  stream(request: ModelTransportRequest): AsyncGenerator<string, void, unknown>
}

export type { BlockedEffectKind }

export interface VerifyStubResult {
  ok: boolean
  command: string
  detail: string
  skipped?: boolean
}

export interface DiagnosticsScope {
  runId: string
  mode: 'simulated' | 'real-model'
  adapter: ModelAdapter
  /**
   * Called whenever a host process, network, MCP, image, background-agent, or
   * Cloud Agent effect is refused. Each effect is refused at its own service
   * boundary, so a caller that forgets an option still cannot reach it.
   */
  onBlockedEffect: (kind: BlockedEffectKind, detail: string) => void
  /** Scripted verification result; absent = verification is reported as skipped. */
  verify?: (request: { root: string; preferTypecheck: boolean }) => VerifyStubResult
  /**
   * Receives each task-ledger event raised inside this scope (context manifests,
   * tool manifests, route decisions), so captures can export them per request.
   */
  onTaskEvent?: (event: { taskId: string; type: string; data: unknown }) => void
}

const scopes = new AsyncLocalStorage<DiagnosticsScope>()

export function runInDiagnosticsScope<T>(scope: DiagnosticsScope, fn: () => T): T {
  return scopes.run(scope, fn)
}

export function activeDiagnosticsScope(): DiagnosticsScope | undefined {
  return scopes.getStore()
}

/** Model ref used by simulated runs. No provider, catalog, or local model resolves it. */
export const SIMULATED_MODEL_REF = 'simulated:scripted'

const SIMULATED_SETTINGS = Symbol.for('eris.simulatedSettings')

/**
 * Marks settings used by a simulated run. Symbols survive the object spreads the
 * agent code uses to derive settings, but never serialize into persisted files.
 */
export function markSimulatedSettings(settings: AppSettings): AppSettings {
  Object.defineProperty(settings, SIMULATED_SETTINGS, { value: true, enumerable: true })
  Object.defineProperty(settings.models, SIMULATED_SETTINGS, { value: true, enumerable: true })
  return settings
}

export function isSimulatedSettings(settings: AppSettings | undefined): boolean {
  const record = settings as unknown as Record<symbol, unknown> | undefined
  const models = settings?.models as unknown as Record<symbol, unknown> | undefined
  return record?.[SIMULATED_SETTINGS] === true || models?.[SIMULATED_SETTINGS] === true
}

export function isSimulatedModelRef(model: string): boolean {
  return model.startsWith('simulated:')
}

/** Throws when a simulated request would otherwise fall through to a provider. */
export function assertProviderCallAllowed(settings: AppSettings, model: string): void {
  if (isSimulatedSettings(settings) || isSimulatedModelRef(model)) {
    throw new Error(
      'A simulated diagnostics request reached the model provider boundary without its scripted adapter. The call was refused.'
    )
  }
}
