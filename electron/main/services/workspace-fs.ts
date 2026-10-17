import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.DS_Store'
])

export class WorkspaceFsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceFsError'
  }
}

export function assertWorkspaceRoot(workspacePath: string | null): string {
  if (!workspacePath) throw new WorkspaceFsError('No workspace is open')
  if (!existsSync(workspacePath)) throw new WorkspaceFsError('Workspace folder does not exist')
  return resolve(workspacePath)
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Realpath of the path, or of its nearest existing ancestor joined with the missing tail. */
export function realpathAllowMissing(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.unshift(basename(cur))
    cur = parent
  }
  return join(realpathOrSelf(cur), ...tail)
}

/** True when target is root or inside it after resolving symlinks. */
export function isPathInside(root: string, target: string): boolean {
  const realRoot = realpathOrSelf(root)
  const realTarget = realpathAllowMissing(target)
  const rel = relative(realRoot, realTarget)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))
}

/**
 * Models copy the workspace folder name from the tree (`MyApp/src/a.ts`).
 * That is the project root, not a child folder, unless that child already exists.
 */
function stripAccidentalWorkspacePrefix(root: string, userPath: string): string {
  let raw = userPath.trim()
  if (!raw) return '.'
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)) return raw
  raw = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  const name = basename(root)
  if (!name || name === '.' || name === '..') return raw || '.'
  while (raw === name || raw.startsWith(`${name}/`)) {
    if (existsSync(resolve(root, raw))) break
    raw = raw === name ? '.' : raw.slice(name.length + 1)
    if (!raw) return '.'
  }
  return raw || '.'
}

/** Resolve a user/model path to an absolute path inside the workspace. */
export function resolveInWorkspace(workspacePath: string, userPath: string): string {
  const root = assertWorkspaceRoot(workspacePath)
  const raw = stripAccidentalWorkspacePrefix(root, (userPath || '.').trim() || '.')
  const abs = resolve(root, raw)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || resolve(root, rel) !== abs || !isPathInside(root, abs)) {
    throw new WorkspaceFsError(`Path escapes workspace: ${userPath}`)
  }
  return abs
}

export function toWorkspaceRelative(workspacePath: string, absPath: string): string {
  const root = assertWorkspaceRoot(workspacePath)
  const rel = relative(root, absPath)
  return rel.split(sep).join('/') || '.'
}

export function listDir(workspacePath: string, userPath = '.'): Array<{
  name: string
  path: string
  isDirectory: boolean
  size?: number
}> {
  const abs = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(abs)) throw new WorkspaceFsError(`Not found: ${userPath}`)
  const st = statSync(abs)
  if (!st.isDirectory()) throw new WorkspaceFsError(`Not a directory: ${userPath}`)
  return readdirSync(abs)
    .filter((name) => name !== '.DS_Store')
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const full = join(abs, name)
      let isDirectory = false
      let size: number | undefined
      try {
        const s = statSync(full)
        isDirectory = s.isDirectory()
        if (!isDirectory) size = s.size
      } catch {
        return null
      }
      return {
        name,
        path: toWorkspaceRelative(workspacePath, full),
        isDirectory,
        size
      }
    })
    .filter(Boolean) as Array<{ name: string; path: string; isDirectory: boolean; size?: number }>
}

export function readWorkspaceFile(
  workspacePath: string,
  userPath: string,
  maxChars = 80_000
): { path: string; content: string; truncated: boolean; bytes: number } {
  const abs = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(abs)) throw new WorkspaceFsError(`Not found: ${userPath}`)
  if (statSync(abs).isDirectory()) throw new WorkspaceFsError(`Is a directory: ${userPath}`)
  const buf = readFileSync(abs)
  const text = buf.toString('utf8')
  const truncated = text.length > maxChars
  return {
    path: toWorkspaceRelative(workspacePath, abs),
    content: truncated ? text.slice(0, maxChars) : text,
    truncated,
    bytes: buf.length
  }
}

export function writeWorkspaceFile(
  workspacePath: string,
  userPath: string,
  content: string
): { path: string; bytes: number; created: boolean } {
  const abs = resolveInWorkspace(workspacePath, userPath)
  const created = !existsSync(abs)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return {
    path: toWorkspaceRelative(workspacePath, abs),
    bytes: Buffer.byteLength(content, 'utf8'),
    created
  }
}

/** Replace an exact substring in a file. Fails if missing or ambiguous (unless replaceAll). */
export function searchReplaceInFile(
  workspacePath: string,
  userPath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): { path: string; replacements: number; before: string; after: string } {
  if (!oldString) throw new WorkspaceFsError('old_string is required')
  const abs = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(abs)) throw new WorkspaceFsError(`Not found: ${userPath}`)
  if (statSync(abs).isDirectory()) throw new WorkspaceFsError(`Is a directory: ${userPath}`)
  const before = readFileSync(abs, 'utf8')
  const count = before.split(oldString).length - 1
  if (count === 0) {
    throw new WorkspaceFsError(`old_string not found in ${userPath}`)
  }
  if (count > 1 && !replaceAll) {
    throw new WorkspaceFsError(
      `old_string found ${count} times in ${userPath}; set replace_all:true or include more context`
    )
  }
  const after = replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString)
  writeFileSync(abs, after, 'utf8')
  return {
    path: toWorkspaceRelative(workspacePath, abs),
    replacements: replaceAll ? count : 1,
    before,
    after
  }
}

/**
 * Minimal unified-diff / Begin-Patch applicator for single-file hunks.
 * Accepts either `*** Begin Patch` / `*** Update File: path` blocks or a classic `---`/`+++`/`@@` diff.
 */
export function applyUnifiedPatch(
  workspacePath: string,
  patchText: string
): { path: string; before: string; after: string } {
  const text = patchText.trim()
  if (!text) throw new WorkspaceFsError('patch is required')

  let relPath = ''
  let hunkBody = text

  const beginUpdate = text.match(/\*\*\*\s+Update File:\s*(.+)/i)
  const beginAdd = text.match(/\*\*\*\s+Add File:\s*(.+)/i)
  if (beginUpdate || beginAdd) {
    relPath = (beginUpdate?.[1] || beginAdd?.[1] || '').trim()
    const start = text.indexOf('\n', text.indexOf(relPath)) + 1
    const endMark = text.indexOf('*** End Patch')
    hunkBody = endMark > 0 ? text.slice(start, endMark) : text.slice(start)
  } else {
    const plus = text.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)
    const minus = text.match(/^---\s+(?:a\/)?(.+)$/m)
    relPath = (plus?.[1] || minus?.[1] || '').trim()
    if (relPath === '/dev/null') relPath = (plus?.[1] || '').trim()
  }

  if (!relPath || relPath === '/dev/null') {
    throw new WorkspaceFsError('Could not determine target path from patch')
  }
  relPath = relPath.replace(/^b\//, '').replace(/^a\//, '')

  const abs = resolveInWorkspace(workspacePath, relPath)
  const before = existsSync(abs) && !statSync(abs).isDirectory() ? readFileSync(abs, 'utf8') : ''
  const after = applyHunkLines(before, hunkBody)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, after, 'utf8')
  return {
    path: toWorkspaceRelative(workspacePath, abs),
    before,
    after
  }
}

function applyHunkLines(original: string, hunkBody: string): string {
  const lines = hunkBody.split(/\r?\n/)
  // Collect change lines from unified hunks (ignore @@ headers and file headers)
  const ops: Array<{ type: 'keep' | 'add' | 'del'; text: string }> = []
  let sawDiffOps = false
  for (const line of lines) {
    if (
      !line ||
      line.startsWith('@@') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('***')
    ) {
      continue
    }
    if (line.startsWith('+')) {
      sawDiffOps = true
      ops.push({ type: 'add', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      sawDiffOps = true
      ops.push({ type: 'del', text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      ops.push({ type: 'keep', text: line.slice(1) })
    } else if (line === '\\ No newline at end of file') {
      continue
    }
  }

  if (!sawDiffOps) {
    // Treat remaining body as full-file replacement when no +/- lines
    const body = lines
      .filter(
        (l) =>
          l &&
          !l.startsWith('@@') &&
          !l.startsWith('---') &&
          !l.startsWith('+++') &&
          !l.startsWith('***')
      )
      .join('\n')
    return body.endsWith('\n') ? body : `${body}\n`
  }

  // Build search (context + deletions) and replacement (context + additions) blocks
  const searchParts: string[] = []
  const replaceParts: string[] = []
  for (const op of ops) {
    if (op.type === 'keep') {
      searchParts.push(op.text)
      replaceParts.push(op.text)
    } else if (op.type === 'del') {
      searchParts.push(op.text)
    } else {
      replaceParts.push(op.text)
    }
  }
  const search = searchParts.join('\n')
  const replace = replaceParts.join('\n')
  if (!search) {
    // Pure additions: append
    if (!original) return replace.endsWith('\n') ? replace : `${replace}\n`
    const base = original.endsWith('\n') ? original : `${original}\n`
    return `${base}${replace}${replace.endsWith('\n') ? '' : '\n'}`
  }
  if (!original.includes(search)) {
    throw new WorkspaceFsError('Patch context did not match file contents')
  }
  return original.replace(search, replace)
}

export function mkdirWorkspace(workspacePath: string, userPath: string): { path: string } {
  const abs = resolveInWorkspace(workspacePath, userPath)
  mkdirSync(abs, { recursive: true })
  return { path: toWorkspaceRelative(workspacePath, abs) }
}

export function deleteWorkspacePath(
  workspacePath: string,
  userPath: string
): { path: string; wasDirectory: boolean } {
  const root = assertWorkspaceRoot(workspacePath)
  const abs = resolveInWorkspace(workspacePath, userPath)
  if (abs === root) throw new WorkspaceFsError('Refusing to delete the workspace root')
  if (!existsSync(abs)) throw new WorkspaceFsError(`Not found: ${userPath}`)
  const wasDirectory = statSync(abs).isDirectory()
  rmSync(abs, { recursive: true, force: true })
  return { path: toWorkspaceRelative(workspacePath, abs), wasDirectory }
}

export function renameWorkspacePath(
  workspacePath: string,
  fromPath: string,
  toPath: string
): { from: string; to: string } {
  const fromAbs = resolveInWorkspace(workspacePath, fromPath)
  const toAbs = resolveInWorkspace(workspacePath, toPath)
  if (!existsSync(fromAbs)) throw new WorkspaceFsError(`Not found: ${fromPath}`)
  if (existsSync(toAbs)) throw new WorkspaceFsError(`Destination already exists: ${toPath}`)
  mkdirSync(dirname(toAbs), { recursive: true })
  renameSync(fromAbs, toAbs)
  return {
    from: toWorkspaceRelative(workspacePath, fromAbs),
    to: toWorkspaceRelative(workspacePath, toAbs)
  }
}

export function workspaceTree(
  workspacePath: string,
  userPath = '.',
  maxDepth = 3
): string {
  const root = resolveInWorkspace(workspacePath, userPath)
  if (!existsSync(root)) throw new WorkspaceFsError(`Not found: ${userPath}`)

  const lines: string[] = []
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth) return
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n !== '.DS_Store')
    } catch {
      return
    }
    names.sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      if (SKIP_DIR_NAMES.has(name)) continue
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      lines.push(`${prefix}${name}${isDir ? '/' : ''}`)
      if (isDir && depth < maxDepth) walk(full, depth + 1, `${prefix}  `)
    }
  }

  const label = toWorkspaceRelative(workspacePath, root)
  lines.push(`${label === '.' ? '.' : label}/`)
  if (statSync(root).isDirectory()) walk(root, 1, '  ')
  return lines.join('\n')
}
