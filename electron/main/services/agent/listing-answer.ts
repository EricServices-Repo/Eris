/**
 * Turn a `tree` or `list_dir` result into the file list a listing question asked
 * for (#508). Used when a listing run ends early: what was observed is posted
 * instead of "Incomplete: The agent produced no successful workspace evidence."
 */

const MAX_LISTED = 200

/** Paths from `tree` output ("./\n  index.html\n  src/\n    app.js"). */
function treePaths(detail: string): string[] {
  const lines = detail.split(/\r?\n/).filter((line) => line.trim())
  const out: string[] = []
  const stack: Array<{ indent: number; name: string }> = []
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length
    const name = raw.trim()
    if (indent === 0 && /^\.\/?$/.test(name)) continue
    // Notes such as "… 12 more" or "(truncated)" are not entries.
    if (/^[(…]|^\.\.\.|more\b/.test(name) && !/\.\w+$/.test(name)) continue
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()
    const prefix = stack.map((entry) => entry.name).join('')
    if (name.endsWith('/')) {
      stack.push({ indent, name })
      out.push(`${prefix}${name}`)
    } else out.push(`${prefix}${name}`)
  }
  return out
}

/** Paths from `list_dir` output ("file index.html (2b)\ndir  src"). */
function listDirPaths(detail: string): string[] {
  return detail
    .split(/\r?\n/)
    .map((line) => line.match(/^(file|dir)\s+(.+?)(?:\s+\(\d+[^)]*\))?\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => (match[1] === 'dir' ? `${match[2]}/` : match[2]!))
}

export function listedPaths(detail: string): string[] {
  const text = detail.trim()
  if (!text) return []
  const paths = /^(?:file|dir)\s/m.test(text) ? listDirPaths(text) : treePaths(text)
  // Eris's own folder is configuration, not project content.
  return paths.filter((path) => !/^\.eris(?:\/|$)/.test(path))
}

/** A bulleted file list built from the last listing, or null when there is none. */
export function listingAnswer(detail: string | null | undefined, note: string): string | null {
  const paths = listedPaths(detail ?? '')
  if (!paths.length) return null
  const shown = paths.slice(0, MAX_LISTED)
  const files = paths.filter((path) => !path.endsWith('/')).length
  const lines = [
    `Files in this project (${files} file${files === 1 ? '' : 's'}):`,
    '',
    ...shown.map((path) => `- \`${path}\``)
  ]
  if (paths.length > shown.length) lines.push(`- … and ${paths.length - shown.length} more`)
  return `${lines.join('\n')}\n\n${note}`
}
