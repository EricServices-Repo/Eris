export type DiffLineStat = { added: number; removed: number }

/** Line-oriented LCS stats for file-list badges. */
export function diffLineStats(before: string, after: string): DiffLineStat {
  // ''.split('\n') => ['']; treat empty docs as zero lines
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const n = a.length
  const m = b.length
  // Banded DP for large files — fall back to crude counts
  if (n * m > 250_000) {
    let added = 0
    let removed = 0
    const setA = new Set(a)
    const setB = new Set(b)
    for (const line of b) if (!setA.has(line)) added++
    for (const line of a) if (!setB.has(line)) removed++
    return { added, removed }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j] ? (dp[i + 1]![j + 1]! + 1) : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  let same = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      same++
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return { added: m - same, removed: n - same }
}

export function languageFromPath(path: string): string {
  const base = (path.split(' → ')[0] || path).split('/').pop() || path
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    htm: 'html',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    xml: 'xml',
    svg: 'xml',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp'
  }
  return map[ext] || 'plaintext'
}
