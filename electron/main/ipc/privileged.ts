import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { appState } from '../app-state'
import { realpathAllowMissing, resolveInWorkspace } from '../services/workspace-fs'
import { loadCheckpoint } from '../services/checkpoints'
import { acquireProjectWrite } from '../services/agent/task-scheduler'
import { privilegedChannel } from '../../../src/shared/privileged-ipc'

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes('\0'))
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const uuid = z.string().uuid()
const index = z.number().int().nonnegative().max(1000000)
const empty = z.tuple([])
const reviewedCommit = z
  .object({
    root: path,
    branch: path,
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    message: z.string().min(1).max(10000),
    action: z.enum(['stage', 'commit']).optional(),
    changes: z
      .array(z.object({ checkpointId: uuid, opIndex: index }).strict())
      .min(1)
      .max(4096)
  })
  .strict()
const schemas: Record<string, z.ZodType> = {
  'checkpoint:restore': z.tuple([uuid]),
  'checkpoint:restoreOp': z.tuple([uuid, index]),
  'checkpoint:review': z.tuple([uuid]),
  'checkpoint:decide': z.tuple([
    z
      .object({
        checkpointId: uuid,
        opIndices: z.array(index).min(1).max(4096),
        decision: z.enum(['keep', 'undo'])
      })
      .strict()
  ]),
  'git:status': empty,
  'git:branches': empty,
  'git:head': empty,
  'git:diff': z.tuple([path.optional()]),
  'git:stage': z.tuple([z.array(path).min(1).max(4096)]),
  'git:commit': z.tuple([z.string().min(1).max(10000)]),
  'git:commitReviewed': z.tuple([reviewedCommit]),
  'git:checkout': z.tuple([
    z
      .object({
        branch: z
          .string()
          .min(1)
          .max(256)
          .refine((s) => !s.startsWith('-') && !/[\x00-\x20]/.test(s)),
        create: z.boolean().optional()
      })
      .strict()
  ]),
  'git:stash': z.tuple([
    z
      .object({
        action: z.enum(['push', 'pop', 'list']).optional(),
        message: z.string().max(10000).optional()
      })
      .strict()
      .optional()
  ]),
  'fs:write': z.tuple([path, z.string().max(8_000_000)]),
  'models:status': z.tuple([
    z
      .object({ probe: z.boolean().optional(), includeGpu: z.boolean().optional() })
      .strict()
      .optional()
  ]),
  'models:warmLocal': z.tuple([z.string().max(512).optional()]),
  'models:builtinStatus': empty,
  'models:localStatus': empty,
  'models:gpuStatus': empty,
  'models:hfBrowseUrl': empty,
  'models:reloadLlamaGpu': empty,
  'models:downloadBuiltin': z.tuple([id]),
  'models:deleteBuiltin': z.tuple([id]),
  'models:verifyBuiltin': z.tuple([id]),
  'models:downloadLocal': z.tuple([id]),
  'models:deleteLocal': z.tuple([id]),
  'models:downloadLocalFromHf': z.tuple([z.string().min(1).max(2048)]),
  'models:searchHfGguf': z.tuple([z.string().max(512)]),
  'models:cancelDownload': empty,
  'models:cancelLocalDownload': empty
}
const envelope = z
  .object({ version: z.literal(1), root: path.nullable(), args: z.array(z.unknown()).max(8) })
  .strict()
const downloadOwners = new Map<string, number>()
function trusted(event: IpcMainInvokeEvent) {
  const window = appState.mainWindow
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error('Unauthorized window or frame')
}
function canonical(root: string | null) {
  return root === null ? null : realpathAllowMissing(root)
}
/** Registration-time adapter: newly added handlers in these capability families fail closed until given a schema. */
export function withPrivilegedRegistration(register: () => void): void {
  const original = ipcMain.handle
  ipcMain.handle = (channel, listener) => {
    if (!privilegedChannel(channel)) return original.call(ipcMain, channel, listener)
    original.call(ipcMain, channel, async (event, raw: unknown, ...extra: unknown[]) => {
      let release: (() => void) | undefined
      let owned: string | undefined
      try {
        trusted(event)
        if (
          extra.length ||
          Buffer.byteLength(JSON.stringify(raw) ?? '') >
            (channel === 'fs:write' ? 9_000_000 : 1_000_000)
        )
          throw new Error('Invalid or oversized request')
        const request = envelope.parse(raw)
        const schema = schemas[channel]
        if (!schema) throw new Error('Unregistered capability schema')
        const args = schema.parse(request.args) as unknown[]
        const root = appState.currentWorkspace
        const isWorkspace = !channel.startsWith('models:')
        const current = () => canonical(appState.currentWorkspace) === canonical(root)
        if (canonical(request.root) !== canonical(root) || (isWorkspace && !root))
          throw new Error('Stale workspace association')
        if (
          channel === 'git:commitReviewed' &&
          canonical((args[0] as { root: string }).root) !== canonical(root)
        )
          throw new Error('Commit workspace mismatch')
        if (channel.startsWith('checkpoint:') && root) {
          const item = args[0]
          const checkpointId =
            typeof item === 'string' ? item : (item as { checkpointId: string }).checkpointId
          const record = loadCheckpoint(root, checkpointId)
          if (!record || canonical(record.workspacePath) !== canonical(root))
            throw new Error('Checkpoint ownership mismatch')
          const indices =
            channel === 'checkpoint:restoreOp'
              ? [args[1] as number]
              : channel === 'checkpoint:decide'
                ? (item as { opIndices: number[] }).opIndices
                : []
          if (indices.some((i) => i >= record.ops.length))
            throw new Error('Checkpoint operation does not exist')
        }
        if (channel === 'fs:write' && root) resolveInWorkspace(root, args[0] as string)
        if (channel === 'git:stage' && root)
          for (const item of args[0] as string[]) resolveInWorkspace(root, item)
        if (
          (channel === 'git:stage' ||
            channel === 'git:commit' ||
            channel === 'git:checkout' ||
            channel === 'git:stash' ||
            channel === 'fs:write') &&
          root
        ) {
          release = await acquireProjectWrite(root)
          trusted(event)
          if (!current()) throw new Error('Workspace changed while waiting for mutation')
        }
        if (channel === 'models:cancelDownload' || channel === 'models:cancelLocalDownload') {
          const keys = channel === 'models:cancelDownload' ? ['builtin', 'local'] : ['local']
          if (!keys.some((key) => downloadOwners.get(key) === event.sender.id))
            throw new Error('No download owned by this window')
          if (
            keys.some(
              (key) => downloadOwners.has(key) && downloadOwners.get(key) !== event.sender.id
            )
          )
            throw new Error('Download belongs to another window')
        }
        if (/^models:download/.test(channel)) {
          const key = channel === 'models:downloadBuiltin' ? 'builtin' : 'local'
          if (downloadOwners.has(key)) throw new Error('A download is already running')
          downloadOwners.set(key, event.sender.id)
          owned = key
        }
        return await listener(event, ...args)
      } catch (error) {
        throw new Error(
          JSON.stringify({
            version: 1,
            code: 'PRIVILEGED_REQUEST_REJECTED',
            channel,
            message:
              error instanceof z.ZodError
                ? 'Request schema mismatch'
                : error instanceof Error
                  ? error.message
                  : 'Request failed'
          })
        )
      } finally {
        if (owned && downloadOwners.get(owned) === event.sender.id) downloadOwners.delete(owned)
        release?.()
      }
    })
  }
  try {
    register()
  } finally {
    ipcMain.handle = original
  }
}
