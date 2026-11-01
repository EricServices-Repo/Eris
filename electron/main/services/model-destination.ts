import { resolveConnectionForModel } from './model-catalog'
import {
  isLoopbackUrl,
  isNativeGgufRef,
  type ModelLocality
} from '../../../src/shared/model-destination'
import type { AppSettings } from '../../../src/shared/settings-schema'

export type ModelDestination = {
  locality: ModelLocality
  /** May receive recall without `shareWithRemoteModels`. */
  recallAllowed: boolean
}

export const NATIVE_DESTINATION: ModelDestination = { locality: 'in-process', recallAllowed: true }
export const REMOTE_DESTINATION: ModelDestination = { locality: 'remote', recallAllowed: false }

/**
 * The one classifier behind compilation, reference binding and dispatch. It uses the
 * resolver the transport uses, so the verdict is about the connection the request
 * will actually take. A LAN host stays remote unless the user approved that exact URL.
 */
export function modelDestination(settings: AppSettings, model: string): ModelDestination {
  if (isNativeGgufRef(model)) return NATIVE_DESTINATION
  const connection = resolveConnectionForModel(settings, model)
  if (connection?.type !== 'openai-compatible') return REMOTE_DESTINATION
  if (isLoopbackUrl(connection.baseUrl)) return { locality: 'loopback', recallAllowed: true }
  return {
    locality: 'remote',
    recallAllowed:
      Boolean(connection.baseUrl) && connection.recallApprovedUrl === connection.baseUrl
  }
}
