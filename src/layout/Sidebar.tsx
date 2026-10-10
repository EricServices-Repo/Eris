import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ChatThread, FileEntry, WorkspaceRecord } from '@/shared/settings-schema'
import { FileTree } from '@/features/workspace/FileTree'

interface Props {
  workspaces: WorkspaceRecord[]
  activeWorkspace: WorkspaceRecord | null
  tree: FileEntry[]
  activeFile: string | null
  threads: ChatThread[]
  activeThreadId: string | null
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  onResizePointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void
  onResizeReset?: () => void
  onCreateWorkspace: () => void
  onLinkWorkspace: () => void
  onSelectWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, name: string) => void
  onRemoveWorkspace: (id: string) => void
  onOpenFile: (path: string) => void
  onAttachFile?: (path: string) => void
  onSelectThread: (id: string) => void
  onNewChat: () => void
  onDeleteThread: (id: string) => void
}

export function Sidebar({
  workspaces,
  activeWorkspace,
  tree,
  activeFile,
  threads,
  activeThreadId,
  collapsed = false,
  onCollapsedChange,
  onResizePointerDown,
  onResizeReset,
  onCreateWorkspace,
  onLinkWorkspace,
  onSelectWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onOpenFile,
  onAttachFile,
  onSelectThread,
  onNewChat,
  onDeleteThread
}: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [chatsOpen, setChatsOpen] = useState(true)
  const [filesOpen, setFilesOpen] = useState(true)

  useEffect(() => {
    if (!activeWorkspace) return
    setExpandedIds((prev) => {
      if (prev.has(activeWorkspace.id)) return prev
      const next = new Set(prev)
      next.add(activeWorkspace.id)
      return next
    })
    setChatsOpen(true)
  }, [activeWorkspace?.id])

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (collapsed) {
    return (
      <div className="icon-rail left-icon-rail" role="toolbar" aria-label="Explorer">
        <button
          type="button"
          className="icon-rail-btn active"
          title="Explorer"
          aria-label="Expand explorer"
          onClick={() => onCollapsedChange?.(false)}
        >
          ☰
        </button>
        <button
          type="button"
          className="icon-rail-btn"
          title="New chat"
          aria-label="New chat"
          onClick={() => {
            onCollapsedChange?.(false)
            onNewChat()
          }}
        >
          ◇
        </button>
        <button
          type="button"
          className="icon-rail-btn"
          title="New workspace"
          aria-label="New workspace"
          onClick={onCreateWorkspace}
        >
          +
        </button>
        <button
          type="button"
          className="icon-rail-btn"
          title="Link folder"
          aria-label="Link folder"
          onClick={onLinkWorkspace}
        >
          ↗
        </button>
        <div className="icon-rail-spacer" />
        <button
          type="button"
          className="icon-rail-btn collapse-toggle"
          title="Expand sidebar"
          aria-label="Expand sidebar"
          onClick={() => onCollapsedChange?.(false)}
        >
          ›
        </button>
      </div>
    )
  }

  return (
    <div className="panel explorer-panel">
      <div className="panel-header">
        <span>Explorer</span>
        <div className="panel-header-actions">
          <button className="btn-ghost" onClick={onCreateWorkspace} title="New Workspace">
            +
          </button>
          <button className="btn-ghost" onClick={onLinkWorkspace} title="Link Folder">
            ↗
          </button>
          {onCollapsedChange && (
            <button
              className="btn-ghost"
              onClick={() => onCollapsedChange(true)}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              ‹
            </button>
          )}
        </div>
      </div>
      {onResizePointerDown && (
        <div
          className="panel-resize-handle panel-resize-handle-end"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize explorer"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizePointerDown}
          onDoubleClick={() => onResizeReset?.()}
        />
      )}

      <div className="panel-body explorer-body">
        <div className="explorer-section explorer-workspaces">
          <div className="explorer-section-label">
            <span>Workspaces</span>
            <span className="badge">{workspaces.length}</span>
          </div>

          {workspaces.length === 0 ? (
            <div className="sidebar-empty" style={{ padding: '16px 12px', height: 'auto' }}>
              <div style={{ marginBottom: 10 }}>No workspaces yet</div>
              <button className="btn btn-primary" onClick={onCreateWorkspace}>
                New Workspace
              </button>
              <button className="btn" style={{ marginTop: 8 }} onClick={onLinkWorkspace}>
                Link Folder
              </button>
            </div>
          ) : (
            <div className="workspace-list">
              {workspaces.map((ws) => {
                const active = activeWorkspace?.id === ws.id
                const expanded = expandedIds.has(ws.id)
                return (
                  <div key={ws.id} className={`workspace-block ${active ? 'active' : ''}`}>
                    <div className={`workspace-row ${active ? 'active' : ''}`}>
                      <button
                        type="button"
                        className="workspace-twistie"
                        title={expanded ? 'Collapse' : 'Expand'}
                        onClick={() => toggleExpanded(ws.id)}
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                      <button
                        className="workspace-main"
                        onClick={() => {
                          onSelectWorkspace(ws.id)
                          setExpandedIds((prev) => new Set(prev).add(ws.id))
                        }}
                        title={ws.path}
                      >
                        <span className="workspace-name">{ws.name}</span>
                      </button>
                      <div className="workspace-actions">
                        <button
                          className="btn-ghost"
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation()
                            const next = window.prompt('Rename workspace', ws.name)
                            if (next && next.trim() && next.trim() !== ws.name) {
                              onRenameWorkspace(ws.id, next.trim())
                            }
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="btn-ghost"
                          title="Remove from list"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (
                              window.confirm(
                                `Remove “${ws.name}” from workspaces?\n\nThe folder on disk is not deleted.`
                              )
                            ) {
                              onRemoveWorkspace(ws.id)
                            }
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </div>

                    {expanded && active && (
                      <div className="project-menu">
                        <div className="project-menu-group">
                          <div className="project-menu-row">
                            <button
                              type="button"
                              className="project-menu-label"
                              onClick={() => setChatsOpen((v) => !v)}
                            >
                              <span className="project-menu-twistie">{chatsOpen ? '▾' : '▸'}</span>
                              <span>Chats</span>
                            </button>
                            <button
                              type="button"
                              className="btn-ghost project-menu-add"
                              title="New chat"
                              onClick={onNewChat}
                            >
                              +
                            </button>
                          </div>
                          {chatsOpen && (
                            <div className="project-menu-items">
                              {threads.length === 0 ? (
                                <button
                                  type="button"
                                  className="project-menu-item muted"
                                  onClick={onNewChat}
                                >
                                  New chat…
                                </button>
                              ) : (
                                threads.map((t) => (
                                  <div key={t.id} className="project-menu-item-row">
                                    <button
                                      type="button"
                                      className={`project-menu-item ${
                                        activeThreadId === t.id ? 'active' : ''
                                      }`}
                                      onClick={() => onSelectThread(t.id)}
                                      title={t.title}
                                    >
                                      {t.title || 'Untitled chat'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-ghost project-menu-delete"
                                      title="Delete chat"
                                      onClick={() => onDeleteThread(t.id)}
                                    >
                                      ×
                                    </button>
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>

                        <div className="project-menu-group">
                          <button
                            type="button"
                            className="project-menu-label"
                            onClick={() => setFilesOpen((v) => !v)}
                          >
                            <span className="project-menu-twistie">{filesOpen ? '▾' : '▸'}</span>
                            <span>Files</span>
                          </button>
                          {filesOpen && (
                            <div className="project-menu-files">
                              <FileTree
                                entries={tree}
                                activePath={activeFile}
                                onOpen={onOpenFile}
                                onAttach={onAttachFile}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
