/** Cooperative search over loaded messages. It never mounts offscreen history or contacts a model. */
export async function searchLoadedHistory(
  messages: readonly { id: string; content: string }[],
  query: string,
  signal?: AbortSignal,
  onBatch?: (ids: string[]) => void
): Promise<string[]> {
  const needle = query.trim().slice(0, 256).toLocaleLowerCase(),
    hits: string[] = []
  if (!needle) return hits
  for (let i = 0; i < messages.length; i++) {
    signal?.throwIfAborted()
    const text = messages[i].content
    for (let offset = 0; offset < text.length; offset += 16384) {
      if (
        text
          .slice(offset, offset + 16384 + needle.length)
          .toLocaleLowerCase()
          .includes(needle)
      ) {
        hits.push(messages[i].id)
        break
      }
    }
    if (i % 50 === 49) {
      onBatch?.([...hits])
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  signal?.throwIfAborted()
  return hits
}
