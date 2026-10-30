/** Newest postings read per query term, so a common word cannot make a query scale with history. */
const MAX_TERM_ROWS = 2048
/** Inverted term index over a thread's retained rows. Row IDs only ever increase. */
export class RecallIndex {
  private postings = new Map<string, number[]>()
  add(row: number, terms: readonly string[]) {
    for (const term of terms) {
      const rows = this.postings.get(term)
      if (rows) rows.push(row)
      else this.postings.set(term, [row])
    }
  }
  /** Rows matching any term, each with the terms it matched. */
  match(terms: readonly string[]) {
    const matches = new Map<number, Set<string>>()
    for (const term of terms) {
      const rows = this.postings.get(term) ?? []
      for (let i = rows.length - 1; i >= Math.max(0, rows.length - MAX_TERM_ROWS); i--) {
        const found = matches.get(rows[i]!)
        if (found) found.add(term)
        else matches.set(rows[i]!, new Set([term]))
      }
    }
    return matches
  }
  /** Forget rows older than `firstRow`; `terms` lists what those rows contributed. */
  prune(firstRow: number, terms: readonly string[]) {
    for (const term of new Set(terms)) {
      const rows = this.postings.get(term)
      if (!rows) continue
      const live = rows.findIndex((row) => row >= firstRow)
      if (live < 0) this.postings.delete(term)
      else if (live > 0) rows.splice(0, live)
    }
  }
}
