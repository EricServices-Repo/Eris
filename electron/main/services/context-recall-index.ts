import { ContextRowDeque } from './context-row-deque'
/** Newest postings read per query term, so a common word cannot make a query scale with history. */
const MAX_TERM_ROWS = 2048
export const MAX_MATCHED_ROWS = 4096
const MAX_QUERY_TERMS = 24
/** Inverted term index over a thread's retained rows. Row IDs only ever increase. */
export class RecallIndex {
  private postings = new Map<string, ContextRowDeque<number>>()
  add(row: number, terms: readonly string[]) {
    for (const term of terms) {
      const rows = this.postings.get(term)
      if (rows) rows.push(row)
      else {
        const rows = new ContextRowDeque<number>()
        rows.push(row)
        this.postings.set(term, rows)
      }
    }
  }
  /** Rows matching any term, each with the terms it matched. */
  match(terms: readonly string[]) {
    const matches = new Map<number, Set<string>>()
    for (const term of terms.slice(0, MAX_QUERY_TERMS)) {
      const rows = this.postings.get(term)
      if (!rows) continue
      for (let i = rows.length - 1; i >= Math.max(0, rows.length - MAX_TERM_ROWS); i--) {
        const found = matches.get(rows.get(i)!)
        if (found) found.add(term)
        else if (matches.size < MAX_MATCHED_ROWS) matches.set(rows.get(i)!, new Set([term]))
      }
    }
    return matches
  }
  /** Forget rows older than `firstRow`; `terms` lists what those rows contributed. */
  prune(firstRow: number, terms: readonly string[]) {
    for (const term of new Set(terms)) {
      const rows = this.postings.get(term)
      if (!rows) continue
      while (rows.length && rows.get(0)! < firstRow) rows.drop(1)
      if (!rows.length) this.postings.delete(term)
    }
  }
}
