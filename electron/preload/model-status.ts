import type { IdeApi } from '../../src/shared/api'

/** Retry only a rejected read, never model downloads, deletes or other mutations. */
export async function readModelStatus(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  options: Parameters<IdeApi['modelsStatus']>[0]
): ReturnType<IdeApi['modelsStatus']> {
  try {
    return (await invoke('models:status', options ?? {})) as Awaited<
      ReturnType<IdeApi['modelsStatus']>
    >
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes('PRIVILEGED_REQUEST_REJECTED') ||
      !message.includes('Stale workspace association')
    )
      throw error
    // Opening/restoring a workspace may overtake the boot catalog request.
    // This goes through the preload wrapper to refresh its root envelope.
    await invoke('workspace:getCurrent')
    return (await invoke('models:status', options ?? {})) as Awaited<
      ReturnType<IdeApi['modelsStatus']>
    >
  }
}
