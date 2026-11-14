/** Retired bundled model identifiers must not remain fixed execution targets. */
export function isRetiredComposerModel(ref: string): boolean {
  return ['builtin:composer-lite', 'builtin:composer', 'composer'].includes(ref.trim())
}

export function migrateRetiredModel(ref: string): string {
  return isRetiredComposerModel(ref) ? 'auto' : ref
}
