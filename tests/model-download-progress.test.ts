import { describe, expect, it } from 'vitest'
import {
  resolveContentRangeTotal,
  resolveDownloadTotal,
  resolveResumeDownloadTotal,
  stablePartialPath
} from '../electron/main/services/http-download'
import {
  downloadStatusLabel,
  mergeDownloadProgressRow,
  upsertDownloadRow,
  type DownloadProgressRow
} from '../src/shared/model-download-ui'

function headers(init: Record<string, string>): Headers {
  return new Headers(init)
}

describe('resume helpers', () => {
  it('builds a stable .partial path', () => {
    expect(stablePartialPath('/models/foo.gguf')).toBe('/models/foo.gguf.partial')
  })

  it('parses Content-Range totals', () => {
    expect(
      resolveContentRangeTotal(headers({ 'content-range': 'bytes 100-999/5000' }))
    ).toBe(5000)
    expect(resolveContentRangeTotal(headers({}))).toBeNull()
  })

  it('adds content-length to existing bytes on HTTP 206', () => {
    const r = resolveResumeDownloadTotal(
      headers({ 'content-length': '900' }),
      2000,
      100,
      206
    )
    expect(r).toEqual({ total: 1000, source: 'content-length+offset' })
  })
})

describe('resolveDownloadTotal', () => {
  it('prefers x-linked-size from Hugging Face', () => {
    const r = resolveDownloadTotal(
      headers({ 'x-linked-size': '1800000000', 'content-length': '999' }),
      1920000000
    )
    expect(r).toEqual({ total: 1800000000, source: 'x-linked-size' })
  })

  it('uses content-length when it agrees with approxBytes', () => {
    const r = resolveDownloadTotal(headers({ 'content-length': '1900000000' }), 1920000000)
    expect(r.source).toBe('content-length')
    expect(r.total).toBe(1900000000)
  })

  it('falls back to approx when content-length disagrees', () => {
    const r = resolveDownloadTotal(headers({ 'content-length': '500000000' }), 1920000000)
    expect(r).toEqual({ total: 1920000000, source: 'approx' })
  })

  it('ignores content-length when content-encoding is set', () => {
    const r = resolveDownloadTotal(
      headers({ 'content-length': '900000000', 'content-encoding': 'gzip' }),
      1920000000
    )
    expect(r).toEqual({ total: 1920000000, source: 'approx' })
  })
})

describe('mergeDownloadProgressRow', () => {
  it('never decreases progress while downloading', () => {
    const prev = {
      id: 'm',
      progress: 0.82,
      downloadedBytes: 820,
      downloading: true,
      downloadPhase: 'downloading' as const
    }
    const stale = {
      id: 'm',
      progress: 0.4,
      downloadedBytes: 400,
      downloading: true,
      downloadPhase: 'downloading' as const
    }
    const merged = mergeDownloadProgressRow(prev, stale)
    expect(merged.progress).toBe(0.82)
    expect(merged.downloadedBytes).toBe(820)
  })

  it('accepts ready completion even if progress was lower', () => {
    const prev: DownloadProgressRow = {
      id: 'm',
      progress: 0.99,
      downloadedBytes: 990,
      downloading: true
    }
    const next: DownloadProgressRow = {
      id: 'm',
      progress: 1,
      downloadedBytes: 1000,
      downloading: false,
      ready: true
    }
    expect(mergeDownloadProgressRow(prev, next).ready).toBe(true)
  })
})

describe('downloadStatusLabel', () => {
  it('shows verifying / installing phases', () => {
    expect(
      downloadStatusLabel(
        { ready: false, downloading: true, downloadPhase: 'verifying', progress: 0.96 },
        'x'
      )
    ).toBe('Verifying…')
    expect(
      downloadStatusLabel(
        { ready: false, downloading: true, downloadPhase: 'finalizing', progress: 0.99 },
        'x'
      )
    ).toBe('Installing…')
  })
})

describe('upsertDownloadRow', () => {
  it('inserts a new downloading model at the front', () => {
    const rows: DownloadProgressRow[] = [
      { id: 'a', progress: 1, downloadedBytes: 10, ready: true, downloading: false }
    ]
    const next = upsertDownloadRow(rows, {
      id: 'hf-new',
      progress: 0,
      downloadedBytes: 0,
      downloading: true,
      downloadPhase: 'downloading'
    })
    expect(next[0]?.id).toBe('hf-new')
    expect(next[0]?.downloading).toBe(true)
    expect(next).toHaveLength(2)
  })
})
