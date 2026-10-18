import type { ChatThread, ChatMessage, FileEntry } from '../../../src/shared/settings-schema'
import type { IndexRecord } from './code-index'

export type ChatPage = { before?: number; limit?: number }
export type WorkspaceRequest =
  | { type: 'tree'; root: string; maxDepth: number }
  | { type: 'read'; path: string }
  | { type: 'index'; root: string; indexPath: string }
  | { type: 'patch-index'; root: string; indexPath: string; paths: string[] }
  | { type: 'load-index'; indexPath: string }
  | { type: 'chat-list'; dir: string }
  | { type: 'chat-get'; dir: string; id: string; page?: ChatPage }
  | { type: 'chat-save'; dir: string; thread: ChatThread }
  | { type: 'chat-delete'; dir: string; id: string }
  | { type: 'chat-append'; dir: string; id: string; message: ChatMessage; model?: string }
  | { type: 'shutdown' }
export type WorkspaceResult<T extends WorkspaceRequest> = T extends { type: 'tree' }
  ? FileEntry[]
  : T extends { type: 'read' }
    ? { path: string; content: string; name: string }
    : T extends { type: 'index' }
      ? IndexRecord
      : T extends { type: 'patch-index' }
        ? IndexRecord
        : T extends { type: 'load-index' }
          ? IndexRecord | null
          : T extends { type: 'chat-list' }
            ? ChatThread[]
            : T extends { type: 'chat-get' }
              ? ChatThread | null
              : T extends { type: 'chat-save' | 'chat-append' }
                ? ChatThread
                : boolean
export type WorkspaceReply = { id: number; result?: unknown; error?: string }
