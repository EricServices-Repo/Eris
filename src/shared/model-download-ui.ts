/** UI helpers for model download progress (monotonic bars, phase labels). */

export type DownloadProgressRow = {
  id: string
  progress: number
  downloadedBytes: number
  downloading?: boolean
  ready?: boolean
  downloadPhase?: 'downloading' | 'verifying' | 'finalizing' | null
  downloadError?: string | null
}

export function downloadStatusLabel(
  row: Pick<DownloadProgressRow, 'ready' | 'downloading' | 'downloadPhase' | 'progress'>,
  fallbackNotReady: string
): string {
  if (row.ready) return 'Ready'
  if (row.downloading) {
    if (row.downloadPhase === 'verifying') return 'Verifying…'
    if (row.downloadPhase === 'finalizing') return 'Installing…'
    const pct = Math.round((row.progress || 0) * 100)
    return pct > 0 ? `Downloading · ${pct}%` : 'Downloading…'
  }
  const pausedPct = Math.round((row.progress || 0) * 100)
  if (pausedPct > 0 && pausedPct < 100) return `Paused · ${pausedPct}% — Resume`
  return fallbackNotReady
}

/** Prefer newer ready/error rows; never let a stale poll decrease live progress. */
export function mergeDownloadProgressRow<T extends DownloadProgressRow>(
  prev: T | undefined,
  next: T
): T {
  if (!prev) return next
  if (next.ready || (!next.downloading && next.downloadError)) return next
  if (prev.downloading || next.downloading) {
    return {
      ...next,
      progress: Math.max(prev.progress || 0, next.progress || 0),
      downloadedBytes: Math.max(prev.downloadedBytes || 0, next.downloadedBytes || 0),
      downloadPhase: next.downloadPhase || prev.downloadPhase,
      downloading: next.downloading || prev.downloading
    }
  }
  return next
}

/** Patch or insert a download row (HF downloads are new catalog ids). */
export function upsertDownloadRow<T extends DownloadProgressRow>(rows: T[], next: T): T[] {
  const idx = rows.findIndex((r) => r.id === next.id)
  if (idx < 0) return [mergeDownloadProgressRow(undefined, next), ...rows]
  return rows.map((r, i) => (i === idx ? mergeDownloadProgressRow(r, next) : r))
}

export function mergeModelsDownloadStatus<
  T extends { builtin?: DownloadProgressRow[]; local?: DownloadProgressRow[] | null }
>(prev: T | null | undefined, next: T): T {
  if (!prev) return next
  const prevBuiltin = new Map((prev.builtin || []).map((b) => [b.id, b]))
  const prevLocal = new Map((prev.local || []).map((m) => [m.id, m]))
  return {
    ...next,
    builtin: (next.builtin || []).map((b) =>
      mergeDownloadProgressRow(prevBuiltin.get(b.id), b)
    ) as T['builtin'],
    local: (next.local || []).map((m) =>
      mergeDownloadProgressRow(prevLocal.get(m.id), m)
    ) as T['local']
  }
}
