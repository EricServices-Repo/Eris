import { captureContextEvidence, validateContextEvidence } from './services/context-evidence-worker'
import { parentPort } from 'worker_threads'
import { readFileSync } from 'fs'
import { listTree, readTextFile } from './services/files'
import { scanWorkspaceIndex, patchWorkspaceIndex } from './services/workspace-index-job'
import {
  chatDatabase,
  closeChatDatabases,
  closeChatDatabase,
  chatStorageUsage
} from './services/chat-database'
import type { WorkspaceRequest } from './services/workspace-worker-protocol'

export async function handleWorkspaceRequest(request: WorkspaceRequest): Promise<unknown> {
  switch (request.type) {
    case 'tree':
      return listTree(request.root, 0, request.maxDepth)
    case 'read':
      return readTextFile(request.path)
    case 'context-evidence-capture':
      return captureContextEvidence(request.root, request.paths)
    case 'context-evidence-validate':
      return validateContextEvidence(request.root, request.snapshots)
    case 'index':
      return scanWorkspaceIndex(request.root, request.indexPath)
    case 'patch-index':
      return patchWorkspaceIndex(request.root, request.indexPath, request.paths)
    case 'load-index': {
      try {
        return JSON.parse(readFileSync(request.indexPath, 'utf8'))
      } catch {
        return null
      }
    }
    case 'context-replay':
      return chatDatabase(request.dir).replayContextChanges(request.limit)
    case 'context-changes':
      return chatDatabase(request.dir).contextChanges(request.after, request.limit)
    case 'context-reference-sources':
      return chatDatabase(request.dir).referenceSources(request.id, request.sources)
    case 'context-header': {
      const db = chatDatabase(request.dir)
      db.replayContextChanges()
      return db.contextHeader(request.id)
    }
    case 'context-archive-search':
      return chatDatabase(request.dir).archiveSearch(request.id, request.query, request.projectRoot)
    case 'context-page':
      return chatDatabase(request.dir).contextPage(
        request.id,
        request.before,
        undefined,
        request.beforeContentOffset
      )
    case 'context-controls':
      return chatDatabase(request.dir).contextControls(
        request.id,
        request.write,
        request.expectedSource
      )
    case 'chat-storage-usage':
      return chatStorageUsage(request.dir)
    case 'chat-close':
      return closeChatDatabase(request.dir)
    case 'chat-list':
      return chatDatabase(request.dir).list()
    case 'chat-get':
      return chatDatabase(request.dir).get(request.id, request.page)
    case 'chat-save':
      return chatDatabase(request.dir).save(request.thread)
    case 'chat-delete':
      return chatDatabase(request.dir).remove(request.id)
    case 'chat-append':
      return chatDatabase(request.dir).append(request.id, request.message, request.model)
    case 'context-source-scope':
      return chatDatabase(request.dir).scopeContextSource(
        request.id,
        request.messageId,
        request.projectRoot
      )
    case 'shutdown':
      closeChatDatabases()
      return true
  }
}
let queue = Promise.resolve()
parentPort?.on('message', ({ id, request }: { id: number; request: WorkspaceRequest }) => {
  queue = queue.then(async () => {
    try {
      parentPort?.postMessage({ id, result: await handleWorkspaceRequest(request) })
    } catch (error) {
      parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
