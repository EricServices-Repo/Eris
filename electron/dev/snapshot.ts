/**
 * Which project entries a diagnostic snapshot copies. Selected non-secret
 * configuration (workspace rules, agents, CI and editor settings) is kept so
 * workspace-specific routing reproduces; secrets and bulk build output never
 * are. Every omission is returned with a category for the run manifest.
 */
export interface SnapshotManifest {
  files: number
  bytes: number
  digest: string
  omitted: Map<string, { count: number; examples: string[] }>
}

const BUILD_OUTPUT = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  'dist-dev',
  'out-dev',
  'vendor',
  'target',
  'build',
  '__pycache__',
  '.next',
  '.venv',
  'venv'
])

/** Hidden entries kept because they shape agent behavior and hold no credentials by design. */
const KEPT_HIDDEN = new Set(['.eris', '.github', '.vscode', '.editorconfig', '.gitignore'])

const SECRET_NAME =
  /^\.env(?:\..*)?$|\.(?:pem|key|p12|pfx|keystore|jks)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.npmrc$|^\.netrc$|^\.pypirc$|credentials|secrets?\.(?:json|bin|ya?ml|toml)(?:\.|$)/i

/** Workspace-local Eris state that is not configuration. */
const ERIS_STATE = /^\.eris\/(?:checkpoints|cache|sessions|index|tmp)(?:\/|$)/

/** Null to copy; otherwise the omission category. */
export function snapshotPolicy(
  relativePath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean
): string | null {
  const name = relativePath.split('/').pop() ?? relativePath
  if (isSymbolicLink) return 'symbolic link'
  if (SECRET_NAME.test(name)) return 'possible secret'
  if (isDirectory && BUILD_OUTPUT.has(name)) return 'dependencies or build output'
  if (name === '.git') return 'version control data'
  if (ERIS_STATE.test(relativePath)) return 'Eris workspace state'
  const top = relativePath.split('/')[0]!
  if (top.startsWith('.') && !KEPT_HIDDEN.has(top)) return 'hidden entry'
  return null
}
