import {
  opendirSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  rmSync,
  rmdirSync,
  mkdirSync,
  realpathSync,
  linkSync,
  unlinkSync
} from 'fs'
import { join, relative, isAbsolute, dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { z } from 'zod'
import { realpathAllowMissing } from './workspace-fs'
import { userDataRoot, workspaceConfigDir } from './paths'
import {
  evidenceBusy,
  storageFailures,
  storageFailure,
  ownerKey,
  threadEvidenceKey,
  readEvidenceOwner
} from './evidence-records'
import type { StorageInventory, StorageCleanup } from '../../../src/shared/storage'
interface Store {
  id: string
  root: string
  schema: string
  scope: string
  sensitivity: string
  retention: string
  automatic: boolean
  records: boolean
}
export function evidenceStores(workspace: string | null): Store[] {
  const user = realpathAllowMissing(userDataRoot()),
    local = workspace
      ? join(realpathSync(workspace), relative(workspace, workspaceConfigDir(workspace)))
      : null
  const specs: Array<[string, string, string, boolean, boolean]> = [
    ['contracts', 'task-contracts', 'TaskContract v2', true, false],
    ['owners', 'task-owners', 'EvidenceOwner v1', true, false],
    ['ledger', 'task-ledger', 'JSONL event sequence', true, false],
    ['jobs', 'chat-jobs', 'ChatJobSnapshot v1', true, false],
    ['diagnostics', 'debug-runs', 'DebugRun v1', true, false],
    ['captures', 'captures', 'Eris-Dev run v2', true, true],
    ['quality', 'quality-runs', 'quality bundle v1', true, false],
    ['images', 'media/images', 'image metadata/pixels', false, false],
    ['models', 'models', 'model catalog/weights', false, true]
  ]
  const stores = specs.map(([id, path, schema, automatic, records]) => ({
    id,
    root: join(user, path),
    schema,
    scope: 'application',
    sensitivity: id === 'models' ? 'model weights' : 'private prompts/source/evidence',
    retention: automatic
      ? '30 days / 200 terminal records; active and unresolved retained'
      : 'manual removal only',
    automatic,
    records
  }))
  if (local)
    for (const [id, path, schema, records] of [
      ['checkpoints', 'checkpoints', 'Checkpoint v1 + legacy', true],
      ['transactions', 'transactions', 'MutationJournal v1', false],
      ['sessions', 'sessions', 'AgentSession v1', true],
      ['runs', 'runs', 'AgentRun v1 + legacy', false]
    ] as const)
      stores.push({
        id,
        root: join(local, path),
        schema,
        scope: 'workspace',
        sensitivity: 'private source/transcripts',
        retention: '30 days / 200 terminal records; active and unresolved retained',
        automatic: true,
        records
      })
  return stores
}
function safePath(store: Store, path: string): string {
  const rel = relative(store.root, path)
  if (rel === '..' || rel.startsWith('..' + requireSep) || isAbsolute(rel))
    throw new Error('Storage path escapes registered store')
  let cursor = store.root
  // Check each existing ancestor, including the store itself; never traverse linked stores.
  const components = store.root.split(/[\\/]/)
  let ancestor = isAbsolute(store.root)
    ? store.root.startsWith('/')
      ? '/'
      : components.shift()! + '\\'
    : ''
  for (const component of components.filter(Boolean)) {
    ancestor = join(ancestor, component)
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
      throw new Error('Linked evidence store refused')
  }
  for (const component of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, component)
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Linked evidence entry refused')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return path
}
import { sep as requireSep } from 'path'
interface Entry {
  store: Store
  path: string
  name: string
  bytes: number
  at: number
  directory: boolean
}
/** Bounded directory enumeration; incomplete scans are explicit, never represented as complete inventories. */
function entries(
  workspace: string | null,
  max = 500,
  only?: string[]
): { rows: Entry[]; truncated: boolean } {
  const rows: Entry[] = []
  const start = Date.now()
  let truncated = false
  for (const store of evidenceStores(workspace).filter((s) => !only || only.includes(s.id))) {
    if (!existsSync(store.root)) continue
    let dir: ReturnType<typeof opendirSync> | undefined
    try {
      safePath(store, store.root)
      dir = opendirSync(store.root)
      let item
      while ((item = dir.readSync())) {
        if (rows.length >= max || Date.now() - start > 100) {
          truncated = true
          break
        }
        if (item.isSymbolicLink()) continue
        const path = safePath(store, join(store.root, item.name))
        const stat = lstatSync(path)
        rows.push({
          store,
          path,
          name: item.name,
          bytes: stat.isDirectory() ? 0 : stat.size,
          at: stat.mtimeMs,
          directory: stat.isDirectory()
        })
      }
    } catch (error) {
      storageFailure(store.root, error)
    } finally {
      dir?.closeSync()
    }
    if (truncated) break
  }
  return { rows, truncated }
}
const readMeta = (entry: Entry): Record<string, unknown> | null => {
  try {
    const path = entry.directory
      ? join(entry.path, entry.store.id === 'captures' ? 'progress.json' : 'meta.json')
      : entry.path
    safePath(entry.store, path)
    if (lstatSync(path).size > 2_000_000) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
function terminal(entry: Entry): boolean {
  if (entry.store.id === 'ledger') {
    try {
      return (
        JSON.parse(
          readFileSync(
            join(userDataRoot(), 'task-owners', entry.name.replace(/\.jsonl$/, '.json')),
            'utf8'
          )
        ).terminal === true
      )
    } catch {
      return false
    }
  }
  if (entry.name.includes('.corrupt-') || entry.name.includes('.tmp')) return false
  const row = readMeta(entry)
  if (!row) return false
  if (entry.store.id === 'contracts')
    return (row.result as { terminal?: unknown })?.terminal === 'complete'
  if (entry.store.id === 'owners') return !entry.directory && row.terminal === true
  if (entry.store.id === 'quality') return (row.report as { state?: string })?.state === 'completed'
  if (entry.store.id === 'checkpoints' || entry.store.id === 'transactions') {
    const taskId =
      typeof row.taskId === 'string'
        ? row.taskId
        : typeof (row.owner as { taskId?: unknown })?.taskId === 'string'
          ? (row.owner as { taskId: string }).taskId
          : null
    return Boolean(
      taskId &&
      readEvidenceOwner(taskId)?.terminal &&
      (entry.store.id !== 'transactions' || row.state === 'applied')
    )
  }
  return ['done', 'completed', 'dismissed'].includes(String(row.status ?? row.state))
}
export function inspectEvidence(workspace: string | null): StorageInventory {
  const scan = entries(workspace)
  return {
    stores: evidenceStores(workspace).map((store) => ({
      ...store,
      root: undefined,
      entries: scan.rows.filter((r) => r.store.id === store.id).length,
      bytes: scan.rows.filter((r) => r.store.id === store.id).reduce((n, r) => n + r.bytes, 0)
    })),
    scanned: scan.rows.length,
    truncated: scan.truncated,
    busy: evidenceBusy(),
    failures: [
      ...storageFailures(),
      ...scan.rows
        .filter((r) => r.name.includes('.corrupt-'))
        .map((r) => ({
          path: r.path,
          message: 'Quarantined unreadable evidence; original retained for recovery',
          at: r.at
        }))
    ]
  }
}
export function cleanupEvidence(workspace: string | null): StorageCleanup {
  if (evidenceBusy())
    throw new Error('Active evidence is pinned; stop running tasks before cleanup')
  const scan = entries(workspace)
  let removed = 0,
    retained = 0
  for (const store of evidenceStores(workspace).sort(
    (a, b) => Number(a.id === 'owners') - Number(b.id === 'owners')
  )) {
    const rows = scan.rows.filter((r) => r.store.id === store.id).sort((a, b) => b.at - a.at)
    for (const [index, row] of rows.entries()) {
      if (evidenceBusy()) throw new Error('A task started; cleanup stopped')
      if (
        !store.automatic ||
        (!(Date.now() - row.at > 30 * 86400000) && index < 200) ||
        !terminal(row)
      ) {
        retained++
        continue
      }
      if (store.id === 'owners') {
        const owner = readMeta(row)
        if (
          (owner?.root !== workspace && owner?.root !== null) ||
          scan.truncated ||
          scan.rows.some(
            (other) =>
              other.path !== row.path &&
              existsSync(other.path) &&
              (readMeta(other)?.taskId === owner?.taskId ||
                (readMeta(other)?.owner as { taskId?: unknown })?.taskId === owner?.taskId ||
                (other.store.id === 'ledger' &&
                  other.name === ownerKey(String(owner?.taskId)) + '.jsonl'))
          )
        ) {
          retained++
          continue
        }
      }
      try {
        safePath(store, row.path)
        if (store.id === 'diagnostics' && row.name.endsWith('.summary.json')) {
          const prefix = row.name.slice(0, -'.summary.json'.length)
          for (const suffix of ['cases.jsonl', 'responses.jsonl']) {
            const companion = safePath(store, join(store.root, prefix + '.' + suffix))
            if (existsSync(companion)) rmSync(companion)
          }
        }
        if (store.id === 'owners') {
          const owner = readMeta(row)
          if (owner && typeof owner.threadId === 'string') {
            const indexed = safePath(
              store,
              join(
                store.root,
                'by-thread',
                threadEvidenceKey(owner.root as string | null, owner.threadId),
                row.name
              )
            )
            if (existsSync(indexed)) rmSync(indexed)
          }
        }
        rmSync(row.path, { recursive: row.directory, force: false })
        removed++
      } catch (error) {
        storageFailure(row.path, error)
        retained++
      }
    }
  }
  return { removed, retained, truncated: scan.truncated }
}
/** Exact ownership only. Legacy/unreadable records are preserved and reported, never guessed from prose. */
export function deleteThreadEvidence(workspace: string | null, thread: string): StorageCleanup {
  if (evidenceBusy())
    throw new Error('A task is active; deletion cannot remove its recovery evidence')
  const canonical = workspace ? realpathSync(workspace) : null
  const stores = evidenceStores(workspace),
    owners = stores.find((s) => s.id === 'owners')!,
    tasks = new Set<string>(),
    checkpoints = new Set<string>()
  let removed = 0,
    retained = 0
  const index = join(owners.root, 'by-thread', threadEvidenceKey(canonical, thread))
  const candidates: Array<{ store: Store; path: string; directory: boolean }> = []
  const collect = (value: Record<string, unknown>) => {
    if (typeof value.taskId === 'string') tasks.add(value.taskId)
    if (typeof value.requestId === 'string') tasks.add(value.requestId)
    if (typeof value.checkpointId === 'string') checkpoints.add(value.checkpointId)
  }
  if (existsSync(index)) {
    safePath(owners, index)
    const dir = opendirSync(index)
    try {
      let row,
        count = 0
      while ((row = dir.readSync())) {
        if (++count > 10000)
          throw new Error('Thread has too many evidence records; export it before deletion')
        const path = safePath(owners, join(index, row.name))
        if (lstatSync(path).size > 20000) throw new Error('Invalid ownership index')
        const owner = JSON.parse(readFileSync(path, 'utf8'))
        if (owner.root !== canonical || owner.threadId !== thread)
          throw new Error('Foreign evidence owner')
        collect(owner)
        candidates.push({ store: owners, path, directory: false })
      }
    } finally {
      dir.closeSync()
    }
  }
  const contract = stores.find((s) => s.id === 'contracts')!
  const contractPath = join(contract.root, threadEvidenceKey(canonical, thread) + '.json')
  if (existsSync(contractPath)) {
    const row = readMeta({
      store: contract,
      path: contractPath,
      name: '',
      at: 0,
      bytes: 0,
      directory: false
    })
    if (row) collect(row)
    candidates.push({ store: contract, path: contractPath, directory: false })
  }
  // Legacy sessions retain exact thread/checkpoint links. Never infer ownership from a prompt.
  const legacyScan = entries(workspace, 1000, ['sessions', 'checkpoints'])
  for (const row of legacyScan.rows) {
    const meta = readMeta(row)
    if (
      meta &&
      (meta.threadId === thread || (meta.owner as { threadId?: unknown })?.threadId === thread)
    ) {
      collect(meta)
      candidates.push(row)
    }
  }
  for (const task of tasks) {
    for (const [storeId, name] of [
      ['ledger', ownerKey(task) + '.jsonl'],
      ['owners', ownerKey(task) + '.json'],
      ['jobs', task + '.json']
    ] as const) {
      const store = stores.find((s) => s.id === storeId)!
      candidates.push({ store, path: join(store.root, name), directory: false })
    }
  }
  const checkpointStore = stores.find((s) => s.id === 'checkpoints')
  if (checkpointStore)
    for (const checkpoint of checkpoints)
      if (/^[a-f0-9-]{36}$/i.test(checkpoint))
        candidates.push({
          store: checkpointStore,
          path: join(checkpointStore.root, checkpoint),
          directory: true
        })
  const relatedScan = entries(workspace, 1000, ['transactions', 'runs', 'jobs'])
  for (const row of relatedScan.rows) {
    const meta = readMeta(row)
    if (
      meta &&
      (tasks.has(String(meta.taskId)) ||
        tasks.has(String(meta.requestId)) ||
        tasks.has(String(meta.id)))
    )
      candidates.push(row)
    else if (row.store.id === 'transactions') retained++
  }
  const seen = new Set<string>()
  // Preflight every path before deletion; unknown or linked data remains untouched.
  for (const candidate of candidates) safePath(candidate.store, candidate.path)
  for (const { store, path, directory } of candidates) {
    if (seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    safePath(store, path)
    rmSync(path, { recursive: directory, force: false })
    removed++
  }
  if (existsSync(index)) {
    try {
      rmdirSync(index)
    } catch {
      /* nonempty/legacy index remains */
    }
  }
  return { removed, retained, truncated: legacyScan.truncated || relatedScan.truncated }
}
const BackupSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string().nullable(),
    files: z
      .array(
        z
          .object({
            store: z.string(),
            path: z.string().min(1).max(4096),
            bytes: z.string().max(32_000_000),
            digest: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .max(1000),
    conversations: z.array(z.unknown()).max(200).optional()
  })
  .strict()
export function backupEvidence(workspace: string | null): z.infer<typeof BackupSchema> {
  if (evidenceBusy()) throw new Error('Stop active tasks before backing up evidence')
  const scan = entries(workspace)
  if (
    scan.rows.some((row) =>
      ['running', 'queued'].includes(String(readMeta(row)?.status ?? readMeta(row)?.state))
    )
  )
    throw new Error('A saved active run is pinned; stop it before backup')
  if (scan.truncated)
    throw new Error(
      'Inventory is incomplete; reduce retained evidence before creating a complete backup'
    )
  const files: Array<{ store: string; path: string; bytes: string; digest: string }> = []
  let total = 0
  function add(store: Store, path: string, depth = 0) {
    if (depth > 4) throw new Error('Backup depth exceeds limit')
    safePath(store, path)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      const dir = opendirSync(path)
      try {
        let item
        while ((item = dir.readSync())) add(store, join(path, item.name), depth + 1)
      } finally {
        dir.closeSync()
      }
      return
    }
    total += stat.size
    if (total > 20_000_000 || files.length >= 1000)
      throw new Error(
        'Evidence backup exceeds 20 MB / 1000 files; export individual large runs separately'
      )
    const bytes = readFileSync(path)
    files.push({
      store: store.id,
      path: relative(store.root, path),
      bytes: bytes.toString('base64'),
      digest: createHash('sha256').update(bytes).digest('hex')
    })
  }
  for (const row of scan.rows) if (row.store.automatic) add(row.store, row.path)
  return { version: 1, workspace, files }
}
export function restoreEvidence(
  workspace: string | null,
  input: unknown
): { restored: number; conflicts: string[]; conversations: unknown[] } {
  if (evidenceBusy()) throw new Error('Stop active tasks before restoring evidence')
  const backup = BackupSchema.parse(input)
  if (backup.workspace !== workspace) throw new Error('Backup belongs to another workspace')
  const stores = evidenceStores(workspace),
    conflicts: string[] = []
  let restored = 0,
    total = 0
  // Validate every entry and digest before any write.
  const prepared = backup.files.map((file) => {
    const store = stores.find((s) => s.id === file.store && s.automatic)
    if (!store) throw new Error('Unknown/protected backup store')
    if (
      isAbsolute(file.path) ||
      !file.path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..')
    )
      throw new Error('Backup path escapes registered store')
    const path = safePath(store, join(store.root, file.path)),
      bytes = Buffer.from(file.bytes, 'base64')
    total += bytes.length
    if (total > 20_000_000 || createHash('sha256').update(bytes).digest('hex') !== file.digest)
      throw new Error('Backup integrity/size check failed')
    return { store, path, bytes }
  })
  for (const { store, path, bytes } of prepared) {
    safePath(store, path)
    if (existsSync(path)) {
      conflicts.push(relative(store.root, path))
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    safePath(store, path)
    const temp = path + '.restore-' + randomUUID()
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
      linkSync(temp, path)
      restored++
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  return { restored, conflicts, conversations: backup.conversations ?? [] }
}
