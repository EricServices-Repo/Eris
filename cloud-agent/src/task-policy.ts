import { z } from 'zod'
import { posix } from 'path'
import { confinedPath } from './workspace-paths.js'

const constraints = z
  .object({
    edit: z.boolean(),
    verification: z.boolean(),
    execution: z.boolean(),
    commit: z.boolean(),
    external: z.boolean()
  })
  .passthrough()
const schema = z
  .object({
    version: z.literal(2),
    taskId: z.string().min(1).max(128),
    scope: z
      .object({
        workspaceRoot: z.string().nullable(),
        projectRoot: z.string().nullable(),
        state: z.enum(['resolved', 'ambiguous', 'missing'])
      })
      .passthrough(),
    authority: z
      .object({
        tools: z.enum(['none', 'read', 'edit', 'full']),
        edit: z.boolean(),
        execute: z.enum(['none', 'verification', 'approved']),
        externalEffects: z.boolean()
      })
      .strict(),
    interpretation: z
      .object({
        forbidsMutation: z.boolean(),
        constraints: constraints.optional(),
        obligations: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()).max(100)
      })
      .passthrough()
      .optional(),
    acceptanceCriteria: z.array(z.string().max(4000)).max(100)
  })
  .passthrough()
export type CloudTask = z.infer<typeof schema>
/** A cloud root corresponds to the desktop workspace; a selected subproject never gains siblings. */
export function parseCloudTask(input: unknown): CloudTask {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 256000)
    throw new Error('Task contract is too large')
  const task = schema.parse(input)
  if (task.scope.state === 'ambiguous')
    throw new Error('Resolve the project before cloud execution')
  if (task.scope.state !== 'resolved' && (task.authority.edit || task.authority.execute !== 'none'))
    throw new Error('Task project must be resolved before mutation or execution')
  scopePrefix(task) // Reject an unrelated project before creating a job.
  return task
}
export function scopePrefix(task: CloudTask): string {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '')
  const workspace = task.scope.workspaceRoot && normalize(task.scope.workspaceRoot)
  const project = task.scope.projectRoot && normalize(task.scope.projectRoot)
  if (!project || project === workspace) return '.'
  if (!workspace || !project.startsWith(workspace + '/'))
    throw new Error('Project is outside the contract workspace')
  const prefix = project.slice(workspace.length + 1)
  if (prefix.split('/').some((part) => part === '..' || part === '.'))
    throw new Error('Invalid contract project path')
  return prefix
}
export function taskWorkspace(workspace: string, task?: CloudTask): string {
  return task ? confinedPath(workspace, scopePrefix(task)) : workspace
}
export function canEdit(task: CloudTask): boolean {
  return (
    ['edit', 'full'].includes(task.authority.tools) &&
    task.authority.edit &&
    !task.interpretation?.forbidsMutation &&
    !task.interpretation?.constraints?.edit
  )
}
export function assertTaskTool(
  task: CloudTask | undefined,
  name: string,
  args: Record<string, unknown>
): void {
  if (!task) return
  const { authority, interpretation } = task
  if (authority.tools === 'none') throw new Error('Task contract forbids tools')
  if (['tree', 'read_file', 'write_file'].includes(name)) {
    const path = String(args.path ?? '.').replace(/\\/g, '/')
    if (path.split('/').some((part) => part === '.git'))
      throw new Error('Git metadata is outside artifact authority')
  }
  if (name === 'write_file' && !canEdit(task)) throw new Error('Task contract forbids edits')
  if (name === 'run') {
    if (
      authority.tools !== 'full' ||
      authority.execute === 'none' ||
      interpretation?.constraints?.execution
    )
      throw new Error('Task contract forbids execution')
    // Verification-only tasks never receive a writable workspace; shell syntax is not an authority boundary.
    if (authority.execute === 'verification' && interpretation?.constraints?.verification)
      throw new Error('Task contract forbids verification')
  }
}
export function artifactPath(task: CloudTask | undefined, path: string): string {
  return task ? posix.join(scopePrefix(task), path.replace(/\\/g, '/')) : path
}
export function assertExternal(task: CloudTask | undefined): void {
  if (
    task &&
    (!task.authority.externalEffects ||
      task.interpretation?.constraints?.external ||
      task.interpretation?.constraints?.commit)
  )
    throw new Error('Task contract forbids publishing or commits')
}
