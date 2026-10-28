import { readdirSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { HASH_EMBEDDING_SPACE, sameEmbeddingSpace } from '../../../src/shared/embedding-space'
import { hashEmbed } from './hash-embeddings'
import { parseSymbolsAndRefs } from './symbol-parse'
import {
  invalidateWorkspaceIgnoreCache,
  shouldSkipDir,
  shouldSkipWorkspacePath
} from './workspace-ignore'
import type { IndexRecord, SymbolHit } from './code-index'

export async function scanWorkspaceIndex(root: string, indexPath: string): Promise<IndexRecord> {
  invalidateWorkspaceIgnoreCache(root)
  const record: IndexRecord = {
    workspacePath: root,
    updatedAt: 0,
    files: [],
    symbols: [],
    refs: [],
    embeddingSpace: HASH_EMBEDDING_SPACE,
    embeddings: {},
    fileMeta: {}
  }
  const dirs = [root]
  while (dirs.length && record.files.length < 8000) {
    const dir = dirs.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (record.files.length >= 8000) break
      const abs = join(dir, name)
      const rel = relative(root, abs).split(sep).join('/')
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (!shouldSkipDir(root, name, rel)) dirs.push(abs)
        continue
      }
      if (
        !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|php|phtml|sql)$/i.test(name) ||
        st.size >= 800_000 ||
        shouldSkipWorkspacePath(root, rel, false)
      )
        continue
      let content: string
      try {
        content = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      const parsed = await parseSymbolsAndRefs(abs, rel, content)
      if (!parsed.symbols.length) {
        const re = /\b(function|class|interface|type|const)\s+([A-Za-z_][\w]*)/g
        let match: RegExpExecArray | null
        while ((match = re.exec(content)) && parsed.symbols.length < 400) {
          parsed.symbols.push({
            name: match[2]!,
            kind: match[1] === 'interface' ? 'type' : match[1]!,
            path: rel,
            line: content.slice(0, match.index).split('\n').length
          } as SymbolHit)
        }
      }
      record.files.push(rel)
      record.symbols.push(...parsed.symbols.slice(0, Math.max(0, 40_000 - record.symbols.length)))
      record.refs!.push(
        ...parsed.refs.slice(0, Math.min(800, Math.max(0, 120_000 - record.refs!.length)))
      )
      record.embeddings![rel] = hashEmbed(`${rel}\n${content.slice(0, 6000)}`)
      record.fileMeta![rel] = { mtimeMs: st.mtimeMs, size: st.size }
    }
  }
  record.updatedAt = Date.now()
  mkdirSync(dirname(indexPath), { recursive: true })
  const temp = `${indexPath}.tmp`
  writeFileSync(temp, JSON.stringify(record), 'utf8')
  renameSync(temp, indexPath)
  return record
}

export async function patchWorkspaceIndex(
  root: string,
  indexPath: string,
  changes: string[]
): Promise<IndexRecord> {
  if (changes.some((path) => /(^|\/)(\.gitignore|\.erisignore)$/.test(path)))
    return scanWorkspaceIndex(root, indexPath)
  let record: IndexRecord
  try {
    record = JSON.parse(readFileSync(indexPath, 'utf8')) as IndexRecord
  } catch {
    return scanWorkspaceIndex(root, indexPath)
  }
  if (!sameEmbeddingSpace(record.embeddingSpace, HASH_EMBEDDING_SPACE))
    return scanWorkspaceIndex(root, indexPath)
  if (record.workspacePath !== root) return scanWorkspaceIndex(root, indexPath)
  const paths = [...new Set(changes.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')))]
  if (paths.some((path) => record.files.some((file) => file.startsWith(`${path}/`))))
    return scanWorkspaceIndex(root, indexPath)
  invalidateWorkspaceIgnoreCache(root)
  const removed = new Set(paths)
  record.symbols = record.symbols.filter((symbol) => !removed.has(symbol.path))
  record.refs = (record.refs ?? []).filter((ref) => !removed.has(ref.path))
  const files = new Set(record.files.filter((path) => !removed.has(path)))
  record.embeddings ??= {}
  record.fileMeta ??= {}
  for (const rel of paths) {
    delete record.embeddings[rel]
    delete record.fileMeta[rel]
    const abs = resolve(root, rel)
    const within = relative(root, abs)
    if (within.startsWith('..') || within.startsWith(sep)) continue
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) return scanWorkspaceIndex(root, indexPath)
    if (
      st.isSymbolicLink() ||
      !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|php|phtml|sql)$/i.test(rel) ||
      st.size >= 800_000 ||
      shouldSkipWorkspacePath(root, rel, false)
    )
      continue
    const content = readFileSync(abs, 'utf8')
    const parsed = await parseSymbolsAndRefs(abs, rel, content)
    if (!parsed.symbols.length) {
      const re = /\b(function|class|interface|type|const)\s+([A-Za-z_][\w]*)/g
      let match: RegExpExecArray | null
      while ((match = re.exec(content)) && parsed.symbols.length < 400)
        parsed.symbols.push({
          name: match[2]!,
          kind: match[1] === 'interface' ? 'type' : match[1]!,
          path: rel,
          line: content.slice(0, match.index).split('\n').length
        })
    }
    files.add(rel)
    record.symbols.push(...parsed.symbols)
    record.refs.push(...parsed.refs.slice(0, 800))
    record.embeddings[rel] = hashEmbed(`${rel}\n${content.slice(0, 6000)}`)
    record.fileMeta[rel] = { mtimeMs: st.mtimeMs, size: st.size }
  }
  record.files = [...files]
  record.symbols = record.symbols.slice(0, 40_000)
  record.refs = record.refs.slice(0, 120_000)
  record.updatedAt = Date.now()
  const temp = `${indexPath}.tmp`
  writeFileSync(temp, JSON.stringify(record), 'utf8')
  renameSync(temp, indexPath)
  return record
}
