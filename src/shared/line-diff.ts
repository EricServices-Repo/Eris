export interface LineChange {
  kind: 'insert' | 'delete'
  /** 1-based line in the original text. Inserts render after this line; 0 means before the first line. */
  oldLine: number
  lines: string[]
}

const MAX_CELLS = 400_000

/** Line hunks between two snapshots. Large files collapse to one replacement. */
export function lineChanges(before: string, after: string): LineChange[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > MAX_CELLS) {
    const out: LineChange[] = []
    if (a.some((line) => line.length > 0) || before.length > 0) {
      out.push({ kind: 'delete', oldLine: 1, lines: a })
    }
    if (b.some((line) => line.length > 0) || after.length > 0) {
      out.push({ kind: 'insert', oldLine: 0, lines: b })
    }
    return out
  }

  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!
    const next = dp[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }

  const raw: LineChange[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (dp[i + 1]![j]! > dp[i]![j + 1]!) {
      raw.push({ kind: 'delete', oldLine: i + 1, lines: [a[i]!] })
      i++
    } else {
      raw.push({ kind: 'insert', oldLine: i, lines: [b[j]!] })
      j++
    }
  }
  while (i < n) {
    raw.push({ kind: 'delete', oldLine: i + 1, lines: [a[i]!] })
    i++
  }
  while (j < m) {
    raw.push({ kind: 'insert', oldLine: i, lines: [b[j]!] })
    j++
  }
  return mergeLineChanges(raw)
}

function mergeLineChanges(raw: LineChange[]): LineChange[] {
  const out: LineChange[] = []
  for (const change of raw) {
    const prev = out[out.length - 1]
    if (!prev || prev.kind !== change.kind) {
      out.push({ ...change, lines: [...change.lines] })
      continue
    }
    const adjacent =
      change.kind === 'delete'
        ? prev.oldLine + prev.lines.length === change.oldLine
        : prev.oldLine === change.oldLine
    if (!adjacent) {
      out.push({ ...change, lines: [...change.lines] })
      continue
    }
    prev.lines.push(...change.lines)
  }
  return out
}
