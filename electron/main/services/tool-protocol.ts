import type { AppSettings } from '../../../src/shared/settings-schema'
import { isNativeGgufRef } from './builtin-model'
import { resolveConnectionForModel } from './model-catalog'

export type ToolCallProtocol = 'native-tools' | 'text-tools'

/**
 * The one tool-call protocol a backend uses. Transport, stream parsing and
 * prompt guidance all read this so a request never describes competing formats.
 */
export function toolProtocolFor(settings: AppSettings, model: string): ToolCallProtocol {
  if (isNativeGgufRef(model)) return 'text-tools'
  return resolveConnectionForModel(settings, model)?.toolProtocol ?? 'native-tools'
}
