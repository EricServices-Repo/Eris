/** Stable persisted values shared by the renderer, intake and context inspector. */
export function isAutomaticModelSelection(value: string | undefined): boolean {
  return value === 'auto' || value === 'auto-local' || value === 'auto-any'
}
