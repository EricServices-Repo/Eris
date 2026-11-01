import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { ContextOriginSchema, type ContextOrigin } from '../../../src/shared/context-origin'
import { userDataRoot, userChatsDir, workspaceChatsDir } from './paths'
import { registeredWorkspaceId } from './workspace'
import { isPathInside, realpathAllowMissing } from './workspace-fs'
import { getResolvedSettings } from './settings'
import { memoryKey } from './context-memory'
import { workspaceRequest } from './workspace-worker-client'
import { abortable } from './context-hydration'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const canonical = (root: string | null) => (root ? realpathAllowMissing(root) : null)
const profile = () => digest(canonical(userDataRoot())!)
const policy = (root: string | null) =>
  digest(JSON.stringify(getResolvedSettings(root).agent.contextMemory))
function key(create: boolean): Buffer {
  const dir = join(userDataRoot(), 'context-capabilities')
  const path = join(dir, 'origin-key')
  if (create) {
    mkdirSync(dir, { recursive: true })
    let fd: number | undefined
    try {
      fd = openSync(path, 'wx', 0o600)
      writeFileSync(fd, randomBytes(32))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  const value = readFileSync(path)
  if (value.length !== 32) throw new Error('Invalid context capability key')
  return value
}
const payload = (value: Omit<ContextOrigin, 'seal'>) =>
  JSON.stringify([
    value.version,
    value.profile,
    value.sourceRoot,
    value.workspaceId,
    value.threadId,
    value.namespace,
    value.projectRelative,
    value.sourceEpoch,
    value.controlsRevision,
    value.policyDigest,
    value.executionRoot,
    value.executionProject,
    value.taskId
  ])
const sign = (value: Omit<ContextOrigin, 'seal'>, create = false) =>
  createHmac('sha256', key(create)).update(payload(value)).digest('hex')
function verify(value: ContextOrigin) {
  const parsed = ContextOriginSchema.parse(value)
  const expected = Buffer.from(sign(parsed), 'hex'),
    actual = Buffer.from(parsed.seal, 'hex')
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual) ||
    parsed.profile !== profile() ||
    canonical(parsed.sourceRoot) !== parsed.sourceRoot ||
    (parsed.sourceRoot &&
      (!parsed.workspaceId || registeredWorkspaceId(parsed.sourceRoot) !== parsed.workspaceId)) ||
    memoryKey(parsed.sourceRoot, parsed.threadId) !== parsed.namespace ||
    policy(parsed.sourceRoot) !== parsed.policyDigest
  )
    throw new Error('Conversation context origin is no longer authorized')
  return parsed
}
function mappedProject(origin: ContextOrigin, root: string | null) {
  if (origin.projectRelative === null) return null
  if (!root) throw new Error('A project context requires an execution workspace')
  const project = realpathAllowMissing(join(root, origin.projectRelative))
  if (!isPathInside(root, project)) throw new Error('Context project escapes its workspace')
  return project
}
export async function createContextOrigin(
  input: {
    sourceRoot: string | null
    threadId: string
    projectRoot: string | null
    taskId: string
  },
  signal?: AbortSignal
): Promise<ContextOrigin | undefined> {
  const sourceRoot = canonical(input.sourceRoot),
    project = canonical(input.projectRoot)
  const workspaceId = sourceRoot ? registeredWorkspaceId(sourceRoot) : null
  if (sourceRoot && !workspaceId) return undefined // An unregistered folder grants no cross-root recall.
  if (project && (!sourceRoot || !isPathInside(sourceRoot, project)))
    throw new Error('Invalid source project')
  const sourceProfile = profile()
  const sourcePolicy = policy(sourceRoot)
  const header = await abortable(
    workspaceRequest({
      type: 'context-header',
      dir: sourceRoot ? workspaceChatsDir(sourceRoot) : userChatsDir(),
      id: input.threadId
    }),
    [signal ?? AbortSignal.timeout(150)]
  )
  if (!header) return undefined
  if (
    sourceProfile !== profile() ||
    sourcePolicy !== policy(sourceRoot) ||
    (sourceRoot && registeredWorkspaceId(sourceRoot) !== workspaceId)
  )
    throw new Error('Conversation source changed during origin admission')
  const value: Omit<ContextOrigin, 'seal'> = {
    version: 1,
    profile: sourceProfile,
    sourceRoot,
    workspaceId,
    threadId: input.threadId,
    namespace: memoryKey(sourceRoot, input.threadId),
    projectRelative: project ? relative(sourceRoot!, project) || '.' : null,
    sourceEpoch: header.sourceEpoch,
    controlsRevision: header.controlsRevision ?? 0,
    policyDigest: sourcePolicy,
    executionRoot: sourceRoot,
    executionProject: project,
    taskId: input.taskId
  }
  return { ...value, seal: sign(value, true) }
}
/** Only the host calls this while constructing the child, never from a model tool argument. */
export function bindContextOrigin(
  origin: ContextOrigin,
  execution: {
    root: string | null
    projectRoot: string | null
    taskId: string
  }
): ContextOrigin {
  const source = verify(origin),
    root = canonical(execution.root)
  if (mappedProject(source, root) !== canonical(execution.projectRoot))
    throw new Error('Child project does not match its conversation source scope')
  const value = {
    ...source,
    executionRoot: root,
    executionProject: canonical(execution.projectRoot),
    taskId: execution.taskId
  }
  return { ...value, seal: sign(value) }
}
/** Rechecked on each search/read. A source identity is never the tool execution root. */
export async function resolveContextOrigin(
  origin: ContextOrigin,
  execution: {
    root: string | null
    projectRoot: string | null
    taskId: string
    threadId: string | null
  },
  signal?: AbortSignal
) {
  const source = verify(origin)
  if (
    source.executionRoot !== canonical(execution.root) ||
    source.executionProject !== canonical(execution.projectRoot) ||
    source.taskId !== execution.taskId ||
    source.threadId !== execution.threadId
  )
    throw new Error('Context origin does not belong to this task')
  const projectRoot = mappedProject(source, source.sourceRoot)
  if (mappedProject(source, source.executionRoot) !== source.executionProject)
    throw new Error('Context project mapping changed')
  const header = await abortable(
    workspaceRequest({
      type: 'context-header',
      dir: source.sourceRoot ? workspaceChatsDir(source.sourceRoot) : userChatsDir(),
      id: source.threadId
    }),
    [signal ?? AbortSignal.timeout(150)]
  )
  if (
    !header ||
    header.sourceEpoch !== source.sourceEpoch ||
    (header.controlsRevision ?? 0) !== source.controlsRevision
  )
    throw new Error('Conversation context changed; rebuild the scoped assignment')
  verify(source) // Recheck registration/policy after the worker await.
  return {
    root: source.sourceRoot,
    threadId: source.threadId,
    projectRoot,
    namespace: source.namespace,
    binding: digest(payload(source))
  }
}
