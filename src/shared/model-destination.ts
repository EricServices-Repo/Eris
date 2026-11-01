/** Pure classification shared by compilation and native runtime adapters. */
export function isNativeGgufRef(model: string): boolean {
  return model.startsWith('builtin:') || model.startsWith('local:')
}

/**
 * Where a model's prompt physically goes. `in-process` runs inside Eris, `loopback`
 * stays on this machine through a local server, and everything else is `remote`.
 */
export type ModelLocality = 'in-process' | 'loopback' | 'remote'

/** Shown in the context inspector and task ledger. */
export type ContextDestinationLabel = 'local' | 'loopback' | 'remote'

export const destinationLabel = (locality: ModelLocality): ContextDestinationLabel =>
  locality === 'in-process' ? 'local' : locality

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * True only for a base URL that reaches this machine. The WHATWG parser is the one
 * `fetch` uses, so this judges the host the request will really go to: names such as
 * `localhost.example.com` and `http://localhost@evil.test` are not loopback, and
 * neither is any URL carrying credentials. Connection names and provider labels are
 * user-editable, so they are never consulted.
 */
export function isLoopbackUrl(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || IPV4_LOOPBACK.test(host)
}
