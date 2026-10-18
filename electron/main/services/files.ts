import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import type { FileEntry } from '../../../src/shared/settings-schema'

const IGNORE = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.DS_Store',
  '.eris',
  '.ericservices-ide'
])

export function listTree(root: string, depth = 0, maxDepth = 8): FileEntry[] {
  if (!existsSync(root) || depth > maxDepth) return []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }

  const entries: FileEntry[] = []
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (IGNORE.has(name) || name.startsWith('.')) continue
    const full = join(root, name)
    let isDirectory = false
    try {
      isDirectory = statSync(full).isDirectory()
    } catch {
      continue
    }
    const entry: FileEntry = {
      name,
      path: full,
      isDirectory
    }
    if (isDirectory && depth < maxDepth) {
      entry.children = listTree(full, depth + 1, maxDepth)
    }
    entries.push(entry)
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function readTextFile(filePath: string): { path: string; content: string; name: string } {
  const content = readFileSync(filePath, 'utf8')
  return { path: filePath, content, name: basename(filePath) }
}

export function writeTextFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf8')
}

export function languageFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.swift': 'swift',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sh': 'shell',
    '.txt': 'plaintext'
  }
  return map[ext] ?? 'plaintext'
}
