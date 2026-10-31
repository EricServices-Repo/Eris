import type { ContextHeader, ContextPage } from './context-memory'
export type ArchiveContextSearch = {
  header: ContextHeader | null
  records: ContextPage['records']
  index: {
    backend: 'sqlite-postings'
    fts5Available: boolean
    builtChunks: number
    complete: boolean
    cursor: number
    contentOffset: number
    candidates: number
    version: 1
  }
}
