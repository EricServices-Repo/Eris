import { workspaceConfigDir } from './paths'
import { createHash, randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

export type FileIdentity =
  | { kind: 'missing' }
  | { kind: 'file' | 'directory'; dev: number; ino: number; digest?: string; mode: number }
export interface MutationPlan {
  root: string
  id: string
  taskId?: string
  checkpointId?: string
  expected: Record<string, FileIdentity>
}
export class MutationConflict extends Error {
  readonly mutationApplied = false
}
export class MutationAppliedError extends Error {
  readonly mutationApplied = true
}
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const LIMIT = 16 * 1024 * 1024
/** Reject link components, including dangling links, rather than following them during mutation. */
export function checkedMutationPath(root: string, path: string): string {
  const canonical = realpathSync(root),
    target = resolve(canonical, path),
    rel = relative(canonical, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new MutationConflict('Mutation must target a path inside the workspace')
  let current = canonical
  for (const part of rel.split(sep)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new MutationConflict('Symlink mutation is unsupported: ' + path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return target
}
export function fileIdentity(root: string, path: string): FileIdentity {
  const absolute = checkedMutationPath(root, path)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (!stat.isFile() && !stat.isDirectory())
    throw new MutationConflict('Unsupported mutation target: ' + path)
  if (stat.isFile() && stat.size > LIMIT)
    throw new MutationConflict('File exceeds reversible mutation limit (16 MiB): ' + path)
  return {
    kind: stat.isFile() ? 'file' : 'directory',
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    ...(stat.isFile() ? { digest: hash(readFileSync(absolute)) } : {})
  }
}
export function assertIdentity(root: string, path: string, expected: FileIdentity): void {
  if (JSON.stringify(fileIdentity(root, path)) !== JSON.stringify(expected))
    throw new MutationConflict('File changed before publication; read it again: ' + path)
}
export function prepareMutationPlan(
  root: string,
  paths: string[],
  plan?: MutationPlan
): MutationPlan {
  const canonical = realpathSync(root)
  if (plan) {
    if (plan.root !== canonical) throw new MutationConflict('Workspace identity changed')
    for (const path of paths) {
      if (!plan.expected[path]) throw new MutationConflict('Path was not authorized: ' + path)
      assertIdentity(root, path, plan.expected[path]!)
    }
    return plan
  }
  return {
    root: canonical,
    id: randomUUID(),
    expected: Object.fromEntries(paths.map((path) => [path, fileIdentity(root, path)]))
  }
}
function durableJson(path: string, value: unknown) {
  const temp = path + '.' + randomUUID() + '.tmp'
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
}
interface Journal {
  version: 1
  id: string
  taskId?: string
  checkpointId?: string
  kind: string
  at: number
  state: 'prepared' | 'applied' | 'partial' | 'conflicted'
  expected: Record<string, FileIdentity>
  before: Record<string, string>
  desired?: { path: string; digest: string }
  error?: string
}
export function journalMutation<T>(
  root: string,
  paths: string[],
  kind: string,
  plan: MutationPlan | undefined,
  desired: Journal['desired'],
  apply: (check: () => void, markApplied: () => void, id: string) => T
): T {
  plan = prepareMutationPlan(root, paths, plan)
  const expected: Record<string, FileIdentity> = {}
  for (const path of paths) {
    expected[path] = plan?.expected[path] ?? fileIdentity(root, path)
    assertIdentity(root, path, expected[path]!)
  }
  const check = () => {
    if (realpathSync(root) !== plan!.root) throw new MutationConflict('Workspace identity changed')
    for (const path of paths) assertIdentity(root, path, expected[path]!)
  }
  const id = randomUUID(),
    directory = checkedMutationPath(
      root,
      relative(resolve(root), workspaceConfigDir(root)) + '/transactions'
    )
  mkdirSync(directory, { recursive: true })
  checkedMutationPath(root, relative(resolve(root), workspaceConfigDir(root)) + '/transactions')
  const filename = join(directory, id + '.json')
  const before: Record<string, string> = {}
  for (const path of paths)
    if (expected[path]?.kind === 'file')
      before[path] = readFileSync(checkedMutationPath(root, path)).toString('base64')
  check()
  const record: Journal = {
    version: 1,
    id,
    taskId: plan?.taskId,
    checkpointId: plan?.checkpointId,
    kind,
    at: Date.now(),
    state: 'prepared',
    expected,
    before,
    ...(desired ? { desired } : {})
  }
  durableJson(filename, record) // Failure here means no target publication is allowed.
  let applied = false
  try {
    const result = apply(
      check,
      () => {
        applied = true
      },
      id
    )
    record.state = 'applied'
    durableJson(filename, record)
    return result
  } catch (error) {
    record.state = applied ? 'partial' : 'conflicted'
    record.error = error instanceof Error ? error.message : String(error)
    try {
      durableJson(filename, record)
    } catch {
      /* the prepared record still preserves recovery evidence */
    }
    if (applied)
      throw new MutationAppliedError(
        `Mutation applied partially or its receipt could not persist. Inspect ${filename}: ${record.error}`
      )
    throw error
  }
}
/** Atomic individual-file publication; new targets use exclusive hard links to avoid clobbering a concurrent create. */
export function publishWorkspaceText(
  root: string,
  path: string,
  content: string,
  plan?: MutationPlan
): void {
  plan = prepareMutationPlan(root, [path], plan)
  const absolute = checkedMutationPath(root, path)
  journalMutation(
    root,
    [path],
    'write',
    plan,
    { path, digest: hash(content) },
    (check, mark, id) => {
      mkdirSync(dirname(absolute), { recursive: true })
      checkedMutationPath(root, path)
      const temporary = join(dirname(absolute), '.eris-write-' + id + '.tmp')
      let fd: number | undefined
      try {
        const identity = plan?.expected[path] ?? fileIdentity(root, path)
        fd = openSync(temporary, 'wx', identity.kind === 'file' ? identity.mode & 0o777 : 0o600)
        writeFileSync(fd, content, 'utf8')
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        check()
        if (identity.kind === 'missing') {
          // rename would overwrite a target created after the check.
          linkSync(temporary, absolute)
          mark()
          unlinkSync(temporary)
        } else {
          renameSync(temporary, absolute)
          mark()
        }
      } finally {
        if (fd !== undefined) closeSync(fd)
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    }
  )
}
/** Read-only recovery inventory. Prepared/partial work is never automatically replayed. */
export function mutationRecovery(
  root: string,
  limit = 200
): Array<{
  id: string
  taskId?: string
  checkpointId?: string
  state: string
  paths: string[]
  error?: string
}> {
  const directory = checkedMutationPath(
    root,
    relative(resolve(root), workspaceConfigDir(root)) + '/transactions'
  )
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .slice(0, Math.min(1000, Math.max(0, limit)))
    .map((name) => {
      try {
        const path = join(directory, name)
        if (lstatSync(path).size > LIMIT * 3) throw new Error('Oversized journal')
        const row = JSON.parse(readFileSync(path, 'utf8')) as Journal
        if (
          row.version !== 1 ||
          !row.expected ||
          !['prepared', 'applied', 'partial', 'conflicted'].includes(row.state)
        )
          throw new Error('Invalid journal schema')
        return {
          id: row.id,
          taskId: row.taskId,
          checkpointId: row.checkpointId,
          state: row.state,
          paths: Object.keys(row.expected),
          error: row.error
        }
      } catch (error) {
        return { id: name, state: 'unreadable', paths: [], error: String(error) }
      }
    })
}
