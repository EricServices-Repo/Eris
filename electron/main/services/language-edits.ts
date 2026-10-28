import { relative, isAbsolute } from 'path'
import { lspDidChange } from './language-servers'
import { randomUUID } from 'crypto'
import { openSync, readSync, closeSync, statSync } from 'fs'
import { pathToFileURL } from 'url'
import { z } from 'zod'
import {
  prepareMutationPlan,
  publishWorkspaceText,
  checkedMutationPath,
  assertIdentity,
  type MutationPlan
} from './file-mutations'
import { acquireProjectWrite } from './agent/task-scheduler'
import { negotiatedEditRequest } from './language-servers'
import { realpathAllowMissing } from './workspace-fs'
import { notifyWorkspaceFilesChanged } from './code-index'
import { invalidateWorkspaceSearchCache } from './workspace-search'
const position = z
  .object({
    line: z.number().int().min(0).max(1000000),
    character: z.number().int().min(0).max(2000000)
  })
  .strict()
const editsSchema = z
  .array(
    z
      .object({
        range: z.object({ start: position, end: position }).strict(),
        newText: z.string().max(2000000)
      })
      .strict()
  )
  .max(2000)
export function applyLanguageTextEdits(before: string, raw: unknown): string {
  const edits = editsSchema.parse(raw),
    lines = before.split('\n'),
    offsets: number[] = [0]
  for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets[i] + lines[i].length + 1)
  const offset = (p: { line: number; character: number }) => {
    if (p.line >= lines.length || p.character > lines[p.line].replace(/\r$/, '').length)
      throw new Error('Edit position is outside document')
    return offsets[p.line] + p.character
  }
  const sorted = edits
    .map((e) => ({ ...e, start: offset(e.range.start), end: offset(e.range.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  let end = -1,
    previousStart = -1
  for (const e of sorted) {
    if (e.end < e.start || e.start < end || e.start === previousStart)
      throw new Error('Overlapping or invalid language edits')
    end = e.end
    previousStart = e.start
  }
  let after = before
  for (const e of sorted.reverse()) after = after.slice(0, e.start) + e.newText + after.slice(e.end)
  if (after.length > 8000000) throw new Error('Edited document exceeds 8 MB')
  return after
}
export function singleDocumentEdits(raw: unknown, path: string, version: number): unknown {
  if (!raw || typeof raw !== 'object') throw new Error('Adapter returned no workspace edit')
  const edit = raw as {
    changes?: Record<string, unknown>
    documentChanges?: Array<{
      textDocument?: { uri: string; version: number | null }
      edits?: unknown
    }>
  }
  const uri = pathToFileURL(path).href
  if (edit.changes && edit.documentChanges) throw new Error('Ambiguous workspace edit')
  if (edit.changes) {
    const entries = Object.entries(edit.changes)
    if (entries.length !== 1 || entries[0][0] !== uri)
      throw new Error('Multi-file/outside-document edits are not supported; no files were changed')
    return entries[0][1]
  }
  if (edit.documentChanges?.length === 1) {
    const item = edit.documentChanges[0]
    if (!item.textDocument || item.textDocument.uri !== uri)
      throw new Error('Resource operations or multi-file edits are unsupported')
    if (item.textDocument.version !== null && item.textDocument.version !== version)
      throw new Error('Stale versioned workspace edit')
    return item.edits
  }
  throw new Error('Only previewed current-document text edits are supported')
}
type Preview = {
  id: string
  root: string
  owner: number
  path: string
  before: string
  after: string
  plan: MutationPlan
  expires: number
  title: string
}
const previews = new Map<string, Preview>()
function prune(reserve = 0) {
  for (const [id, p] of previews) if (p.expires < Date.now()) previews.delete(id)
  const bytes = () =>
    [...previews.values()].reduce((sum, p) => sum + 2 * (p.before.length + p.after.length), 0)
  while (previews.size && (previews.size >= 32 || bytes() + reserve > 16000000))
    previews.delete(previews.keys().next().value!)
}
export async function previewLanguageEdit(
  root: string,
  input: {
    path: string
    text: string
    kind: 'formatting' | 'rename' | 'codeActions'
    params: Record<string, unknown>
  },
  owner: number,
  current: () => boolean
) {
  prune()
  const path = checkedMutationPath(
    root,
    isAbsolute(input.path) ? relative(root, input.path) : input.path
  )
  if (statSync(path).size > 2000000) throw new Error('Language edit source exceeds 2 MB')
  const plan = prepareMutationPlan(root, [path])
  const fd = openSync(path, 'r'),
    bytes = Buffer.alloc(2000001)
  let count = 0
  try {
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null)
      if (!read) break
      count += read
    }
  } finally {
    closeSync(fd)
  }
  if (count > 2000000) throw new Error('Language edit source exceeds 2 MB')
  const before = bytes.subarray(0, count).toString('utf8')
  assertIdentity(root, path, plan.expected[path])
  if (before.length > 2000000 || before !== input.text)
    throw new Error('Save or resolve dirty document changes before requesting a language edit')
  await lspDidChange(root, path, '', input.text)
  if (!current()) throw new Error('Workspace changed before language request')
  const { response, version } = await negotiatedEditRequest(root, path, input.kind, input.params)
  if (!current()) throw new Error('Workspace changed while requesting language edit')
  assertIdentity(root, path, plan.expected[path])
  const candidates =
    input.kind === 'codeActions'
      ? Array.isArray(response)
        ? response.slice(0, 16)
        : []
      : [{ title: input.kind, edit: response }]
  return candidates.map((raw) => {
    const candidate = raw as {
        title?: string
        edit?: unknown
        command?: unknown
        disabled?: unknown
      },
      title = String(candidate.title ?? input.kind).slice(0, 256)
    try {
      if (candidate.command || candidate.disabled)
        throw new Error(
          'Adapter commands/disabled actions cannot execute through the text-edit capability'
        )
      const edits =
        input.kind === 'formatting'
          ? candidate.edit
          : singleDocumentEdits(candidate.edit, path, version)
      const after = applyLanguageTextEdits(before, edits)
      if (after === before) return { title, reason: 'No text changes' }
      const size = 2 * (before.length + after.length)
      if (size > 4000000) throw new Error('Language edit preview exceeds 4 MB')
      prune(size)
      const id = randomUUID()
      previews.set(id, {
        id,
        root: realpathAllowMissing(root),
        owner,
        path,
        before,
        after,
        plan,
        expires: Date.now() + 120000,
        title
      })
      return { id, title, path, before, after }
    } catch (error) {
      return { title, reason: error instanceof Error ? error.message : 'Unsupported language edit' }
    }
  })
}
export async function applyLanguageEdit(
  root: string,
  id: string,
  owner: number,
  current: () => boolean
) {
  const item = previews.get(id)
  if (
    !item ||
    item.owner !== owner ||
    item.root !== realpathAllowMissing(root) ||
    item.expires < Date.now()
  )
    throw new Error('Preview expired or belongs to another owner/workspace')
  // Consume before waiting: duplicate confirmation cannot replay an effect.
  previews.delete(id)
  const release = await acquireProjectWrite(root)
  try {
    if (!current()) throw new Error('Workspace changed while waiting to apply edit')
    publishWorkspaceText(root, item.path, item.after, item.plan)
    notifyWorkspaceFilesChanged(root, [relative(realpathAllowMissing(root), item.path)])
    invalidateWorkspaceSearchCache(root)
    return { path: item.path, content: item.after }
  } finally {
    release()
  }
}
