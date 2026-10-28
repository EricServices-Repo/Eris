export type LanguageCapabilities = {
  version: 1
  ready: boolean
  adapter: string
  hover: boolean
  definition: boolean
  references: boolean
  completion: boolean
  formatting: boolean
  rename: boolean
  codeActions: boolean
  workspaceEdits: 'single-document-preview'
  reason?: string
}
export function languageCapabilities(
  adapter: string,
  raw: unknown,
  ready = true
): LanguageCapabilities {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const enabled = (key: string) =>
    ready && (c[key] === true || (!!c[key] && typeof c[key] === 'object'))
  return {
    version: 1,
    ready,
    adapter,
    hover: enabled('hoverProvider'),
    definition: enabled('definitionProvider'),
    references: enabled('referencesProvider'),
    completion: enabled('completionProvider'),
    formatting: enabled('documentFormattingProvider'),
    rename: enabled('renameProvider'),
    codeActions: enabled('codeActionProvider'),
    workspaceEdits: 'single-document-preview',
    ...(!ready ? { reason: 'Language server unavailable or document not open' } : {})
  }
}
export const NODE_DEBUG_CAPABILITIES = Object.freeze({
  version: 1,
  adapter: 'node-inspector',
  transport: 'cdp-loopback',
  launch: true,
  attach: false,
  remote: false,
  breakpoints: true,
  stepping: true,
  variables: false,
  watches: false,
  exceptions: false,
  reason:
    'Node launch only. Node inspector has no variables/watch/exception UI. Optional user-configured stdio DAP adapters add these capabilities; remote attach is unsupported.'
})
