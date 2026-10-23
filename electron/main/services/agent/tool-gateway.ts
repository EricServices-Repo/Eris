import { createHash } from 'crypto'
import { existsSync, readFileSync, realpathSync } from 'fs'
import type { TaskContract } from '../../../../src/shared/task-contract'
import { getToolContract } from '../tool-registry'
import {
  isPathInside,
  resolveInWorkspace,
  realpathAllowMissing,
  unifiedPatchTargetPath
} from '../workspace-fs'
import { isVerifyCommand } from '../command-approval'
import type { ToolCall } from './types'

export interface EvidenceRecord {
  id: string
  tool: string
  path?: string
  ok: boolean
  mutated: boolean
  digest: string
  beforeDigest?: string
  afterDigest?: string
  at: string
}
const fileTools = new Set([
  'read_file',
  'notebook_read',
  'write_file',
  'search_replace',
  'apply_patch',
  'notebook_edit',
  'mkdir',
  'delete_path',
  'rename_path',
  'image_save',
  'generate_image'
])
export class TaskToolGateway {
  readonly evidence: EvidenceRecord[] = []
  private partialReads = new Set<string>()
  private readHashes = new Map<string, string>()
  constructor(readonly task: TaskContract) {}
  private hash(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  rememberRead(path: string, complete = true): void {
    try {
      const abs = realpathAllowMissing(resolveInWorkspace(this.task.scope.workspaceRoot!, path))
      this.readHashes.set(abs, this.hash(abs))
      if (complete) this.partialReads.delete(abs)
      else this.partialReads.add(abs)
    } catch {
      /* unavailable source */
    }
  }
  authorize(workspace: string, call: ToolCall, mcpReadOnly = false): string | null {
    const contract = getToolContract(call.name)
    const { authority, scope } = this.task
    if (scope.workspaceRoot && workspace !== scope.workspaceRoot) {
      try {
        if (realpathSync(workspace) !== scope.workspaceRoot)
          return 'The task belongs to a different workspace.'
      } catch {
        return 'Task workspace is unavailable.'
      }
    }
    if (call.name === 'run') {
      if (authority.execute === 'none') return 'This task does not permit shell execution.'
      if (authority.execute === 'verification' && !isVerifyCommand(String(call.args.command ?? '')))
        return 'This task only permits verification commands.'
      const forbidden = this.task.interpretation?.constraints
      const command = String(call.args.command ?? '')
      if (forbidden?.commit && /\bgit\s+(?:commit|push|merge|rebase|tag)\b/i.test(command))
        return 'The request forbids committing.'
      if (forbidden?.external && /\b(?:git\s+push|npm\s+publish|deploy)\b/i.test(command))
        return 'The request forbids pushing, deploying or publishing.'
      // Existing command approval remains mandatory for general commands.
      if (scope.projectRoot && scope.projectRoot !== scope.workspaceRoot) {
        const cwd = String(call.args.cwd ?? scope.projectRoot)
        try {
          if (!isPathInside(scope.projectRoot, resolveInWorkspace(workspace, cwd)))
            return 'Set the command cwd to the selected project.'
        } catch {
          return 'Invalid command directory.'
        }
      }
    }
    if (contract?.effect === 'workspace' && !authority.edit)
      return 'The task contract does not permit workspace changes.'
    if (
      (contract?.effect === 'external' || call.name.startsWith('mcp__')) &&
      !mcpReadOnly &&
      !authority.externalEffects
    )
      return 'The task contract does not permit external side effects.'
    if (contract?.effect === 'command' && call.name !== 'run' && !authority.externalEffects)
      return 'The task contract does not permit this command.'
    if (!contract && !call.name.startsWith('mcp__')) return 'Unknown tool contract.'
    if (fileTools.has(call.name)) {
      if (scope.state !== 'resolved' || !scope.projectRoot)
        return 'Resolve the named project before accessing its files.'
      let paths: string[]
      try {
        paths =
          call.name === 'apply_patch'
            ? [unifiedPatchTargetPath(String(call.args.patch ?? call.args.diff ?? ''))]
            : call.name === 'rename_path'
              ? [String(call.args.path ?? ''), String(call.args.to ?? '')]
              : [String(call.args.path ?? '')]
        for (const path of paths) {
          const abs = realpathAllowMissing(resolveInWorkspace(workspace, path))
          if (!path || !isPathInside(scope.projectRoot, abs))
            return `Blocked ${call.name}: ${path} belongs to another project.`
          if (call.name === 'write_file' && this.partialReads.has(abs))
            return 'The file was only partially inspected. Use search_replace or read the full file before rewriting it.'
          const before = this.readHashes.get(abs)
          if (
            contract?.effect === 'workspace' &&
            before &&
            (!existsSync(abs) || this.hash(abs) !== before)
          )
            return `File ${path} changed after inspection. Read it again before editing.`
        }
      } catch {
        return 'Invalid scoped tool path.'
      }
    }
    return null
  }
  record(
    id: string,
    call: ToolCall,
    result: { ok: boolean; mutated: boolean; path?: string; detail: string }
  ): EvidenceRecord {
    const item = {
      id,
      tool: call.name,
      path: result.path,
      ok: result.ok,
      mutated: result.mutated,
      digest: createHash('sha256').update(result.detail).digest('hex'),
      at: new Date().toISOString()
    }
    if (result.path) {
      try {
        const path = realpathAllowMissing(
          resolveInWorkspace(this.task.scope.workspaceRoot!, result.path)
        )
        Object.assign(item, {
          beforeDigest: this.readHashes.get(path),
          afterDigest: existsSync(path) ? this.hash(path) : undefined
        })
      } catch {
        /* non-file evidence remains represented by output digest */
      }
    }
    this.evidence.push(item)
    if (result.ok && ['read_file', 'notebook_read'].includes(call.name) && result.path)
      this.rememberRead(
        result.path,
        call.args.start_line === undefined &&
          call.args.end_line === undefined &&
          !result.detail.includes('[truncated at')
      )
    if (result.mutated && result.path) {
      try {
        const path = realpathAllowMissing(
          resolveInWorkspace(this.task.scope.workspaceRoot!, result.path)
        )
        // Preserve a baseline after our own edit so subsequent external changes are detected.
        if (existsSync(path)) this.readHashes.set(path, this.hash(path))
        else this.readHashes.delete(path)
      } catch {
        /* path failure already recorded */
      }
    }
    return item
  }
}
