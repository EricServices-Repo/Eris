import { useState } from 'react'
import type { FileEntry } from '@/shared/settings-schema'

interface Props {
  entries: FileEntry[]
  activePath: string | null
  onOpen: (path: string) => void
  onAttach?: (path: string) => void
  depth?: number
}

function TreeNode({
  entry,
  activePath,
  onOpen,
  onAttach,
  depth
}: {
  entry: FileEntry
  activePath: string | null
  onOpen: (path: string) => void
  onAttach?: (path: string) => void
  depth: number
}) {
  const [open, setOpen] = useState(depth < 1)

  return (
    <div>
      <div
        className={`tree-item ${!entry.isDirectory && activePath === entry.path ? 'active' : ''}`}
        style={{ paddingLeft: 10 + depth * 12, display: 'flex', width: '100%' }}
      >
        <button
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            textAlign: 'left',
            padding: 0,
            background: 'transparent'
          }}
          onClick={() => {
            if (entry.isDirectory) setOpen((v) => !v)
            else onOpen(entry.path)
          }}
          onContextMenu={(e) => {
            if (entry.isDirectory || !onAttach) return
            e.preventDefault()
            onAttach(entry.path)
          }}
          title={
            entry.isDirectory
              ? entry.path
              : `${entry.path}\nRight-click to attach for agent`
          }
        >
          <span style={{ opacity: 0.7, width: 12, display: 'inline-block' }}>
            {entry.isDirectory ? (open ? '▾' : '▸') : '·'}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.name}
          </span>
        </button>
        {!entry.isDirectory && onAttach && (
          <button
            className="btn-ghost"
            title="Attach to agent"
            style={{ padding: '0 4px', opacity: 0.7 }}
            onClick={(e) => {
              e.stopPropagation()
              onAttach(entry.path)
            }}
          >
            ↗
          </button>
        )}
      </div>
      {entry.isDirectory && open && entry.children && entry.children.length > 0 && (
        <FileTree
          entries={entry.children}
          activePath={activePath}
          onOpen={onOpen}
          onAttach={onAttach}
          depth={depth + 1}
        />
      )}
    </div>
  )
}

export function FileTree({ entries, activePath, onOpen, onAttach, depth = 0 }: Props) {
  return (
    <div>
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          activePath={activePath}
          onOpen={onOpen}
          onAttach={onAttach}
          depth={depth}
        />
      ))}
    </div>
  )
}
