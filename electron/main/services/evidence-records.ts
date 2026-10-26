import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  statSync,
  readFileSync,
  realpathSync
} from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod'
import { userDataRoot } from './paths'
const failures = new Map<string, { path: string; message: string; at: number }>()
let pins = 0
export function pinEvidence(): () => void {
  pins++
  let released = false
  return () => {
    if (!released) {
      released = true
      pins--
    }
  }
}
export const evidenceBusy = () => pins > 0
function persistHealth(): void {
  try {
    const directory = userDataRoot()
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'storage-health.json'),
      temp = path + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify([...failures.values()]), { mode: 0o600 })
    renameSync(temp, path)
  } catch {
    /* disk-full/read-only health remains visible in memory */
  }
}
export function storageFailure(path: string, error: unknown): void {
  failures.set(path, {
    path,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    at: Date.now()
  })
  while (failures.size > 50) failures.delete(failures.keys().next().value!)
  persistHealth()
}
export const storageFailures = () => {
  const path = join(userDataRoot(), 'storage-health.json')
  try {
    if (existsSync(path) && statSync(path).size < 150000)
      for (const item of JSON.parse(readFileSync(path, 'utf8'))) {
        if (
          typeof item.path === 'string' &&
          typeof item.message === 'string' &&
          !failures.has(item.path)
        )
          failures.set(item.path, item)
      }
  } catch {
    /* original health data remains preserved */
  }
  return [...failures.values()].slice(-50)
}
export function atomicEvidenceJson(path: string, value: unknown): void {
  const temp = path + '.' + randomUUID() + '.tmp'
  let fd: number | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    if (failures.delete(path)) persistHealth()
  } catch (error) {
    storageFailure(path, error)
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
}
export function readEvidence<T>(
  path: string,
  validate: (value: unknown) => T,
  maxBytes = 2_000_000
): T | null {
  if (!existsSync(path)) return null
  try {
    if (statSync(path).size > maxBytes) throw new Error('Record exceeds bounded recovery size')
    return validate(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    storageFailure(path, error)
    try {
      renameSync(path, path + '.corrupt-' + randomUUID())
    } catch {
      /* preserve original when quarantine fails */
    }
    return null
  }
}
export const ownerKey = (taskId: string) => createHash('sha256').update(taskId).digest('hex')
export const threadEvidenceKey = (root: string | null, thread: string) =>
  createHash('sha256')
    .update(JSON.stringify([root, thread]))
    .digest('hex')
const OwnerSchema = z.object({
  version: z.literal(1),
  taskId: z.string().max(256),
  threadId: z.string().max(256).nullable(),
  root: z.string().max(4096).nullable(),
  terminal: z.boolean(),
  checkpointId: z.string().optional()
})
export type EvidenceOwner = z.infer<typeof OwnerSchema>
export function saveEvidenceOwner(owner: EvidenceOwner): void {
  const path = join(userDataRoot(), 'task-owners', ownerKey(owner.taskId) + '.json')
  const previous = readEvidence(path, (value) => OwnerSchema.parse(value))
  let root = owner.root
  try {
    if (root) root = realpathSync(root)
  } catch {
    /* unavailable root stays explicit */
  }
  const record = OwnerSchema.parse({ ...previous, ...owner, root })
  atomicEvidenceJson(path, record)
  if (record.threadId)
    atomicEvidenceJson(
      join(
        userDataRoot(),
        'task-owners',
        'by-thread',
        threadEvidenceKey(root, record.threadId),
        ownerKey(record.taskId) + '.json'
      ),
      record
    )
}
export function readEvidenceOwner(taskId: string): EvidenceOwner | null {
  return readEvidence(join(userDataRoot(), 'task-owners', ownerKey(taskId) + '.json'), (value) =>
    OwnerSchema.parse(value)
  )
}
