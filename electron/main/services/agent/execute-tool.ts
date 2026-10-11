import {
  applyUnifiedPatch,
  deleteWorkspacePath,
  listDir,
  mkdirWorkspace,
  readWorkspaceFile,
  renameWorkspacePath,
  searchReplaceInFile,
  WorkspaceFsError,
  workspaceTree,
  writeWorkspaceFile
} from '../workspace-fs'
import { argString } from './tool-parsing'
import type { ToolCall } from './types'

export function executeTool(
  workspacePath: string,
  call: ToolCall
): { ok: boolean; detail: string; mutated: boolean; path?: string } {
  const name = call.name
  try {
    switch (name) {
      case 'tree': {
        const path = argString(call.args, 'path', '.')
        const maxDepth =
          typeof call.args.maxDepth === 'number' ? Math.min(6, Math.max(1, call.args.maxDepth)) : 3
        const tree = workspaceTree(workspacePath, path, maxDepth)
        return { ok: true, detail: tree, mutated: false, path }
      }
      case 'list_dir': {
        const path = argString(call.args, 'path', '.')
        const entries = listDir(workspacePath, path)
        const detail = entries
          .map((e) => `${e.isDirectory ? 'dir ' : 'file'} ${e.path}${e.size != null ? ` (${e.size}b)` : ''}`)
          .join('\n')
        return { ok: true, detail: detail || '(empty)', mutated: false, path }
      }
      case 'read_file': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        const file = readWorkspaceFile(workspacePath, path)
        const detail = file.truncated
          ? `${file.content}\n\n[truncated at ${file.content.length} chars; file is ${file.bytes} bytes]`
          : file.content
        return { ok: true, detail, mutated: false, path: file.path }
      }
      case 'write_file': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        if (typeof call.args.content !== 'string') {
          throw new WorkspaceFsError('content is required (string)')
        }
        const result = writeWorkspaceFile(workspacePath, path, call.args.content)
        return {
          ok: true,
          detail: `${result.created ? 'Created' : 'Updated'} ${result.path} (${result.bytes} bytes)`,
          mutated: true,
          path: result.path
        }
      }
      case 'search_replace': {
        const path = argString(call.args, 'path')
        const oldString = argString(call.args, 'old_string') || argString(call.args, 'oldString')
        const newString =
          typeof call.args.new_string === 'string'
            ? call.args.new_string
            : typeof call.args.newString === 'string'
              ? call.args.newString
              : null
        if (!path) throw new WorkspaceFsError('path is required')
        if (!oldString) throw new WorkspaceFsError('old_string is required')
        if (newString == null) throw new WorkspaceFsError('new_string is required')
        const replaceAll = Boolean(call.args.replace_all ?? call.args.replaceAll)
        const result = searchReplaceInFile(workspacePath, path, oldString, newString, replaceAll)
        return {
          ok: true,
          detail: `Replaced ${result.replacements} occurrence(s) in ${result.path}`,
          mutated: true,
          path: result.path
        }
      }
      case 'apply_patch': {
        const patch = argString(call.args, 'patch') || argString(call.args, 'diff')
        if (!patch) throw new WorkspaceFsError('patch is required')
        const result = applyUnifiedPatch(workspacePath, patch)
        return {
          ok: true,
          detail: `Applied patch to ${result.path}`,
          mutated: true,
          path: result.path
        }
      }
      case 'mkdir': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        const result = mkdirWorkspace(workspacePath, path)
        return { ok: true, detail: `Created directory ${result.path}`, mutated: true, path: result.path }
      }
      case 'delete_path': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        const result = deleteWorkspacePath(workspacePath, path)
        return {
          ok: true,
          detail: `Deleted ${result.path}${result.wasDirectory ? ' (directory)' : ''}`,
          mutated: true,
          path: result.path
        }
      }
      case 'rename_path': {
        const path = argString(call.args, 'path')
        const to = argString(call.args, 'to')
        if (!path || !to) throw new WorkspaceFsError('path and to are required')
        const result = renameWorkspacePath(workspacePath, path, to)
        return {
          ok: true,
          detail: `Renamed ${result.from} → ${result.to}`,
          mutated: true,
          path: result.to
        }
      }
      default:
        return { ok: false, detail: `Unknown tool: ${name}`, mutated: false }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: message, mutated: false, path: argString(call.args, 'path') || undefined }
  }
}
