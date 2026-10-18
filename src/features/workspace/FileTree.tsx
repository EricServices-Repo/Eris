import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@/shared/settings-schema'
import { VirtualList } from '@/components/VirtualList'

interface Props {
  entries: FileEntry[]
  activePath: string | null
  onOpen: (path: string) => void
  onAttach?: (path: string) => void
  depth?: number
}
type Row = { entry: FileEntry; depth: number }
const rowKey = (row: Row) => row.entry.path

export const FileTree = memo(function FileTree({
  entries,
  activePath,
  onOpen,
  onAttach,
  depth = 0
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState(new Map<string, FileEntry[]>())
  const [errors, setErrors] = useState(new Map<string, string>())
  const inFlight = useRef(new Set<string>())
  const generation = useRef(0)
  const root = entries[0]?.path.replace(/[/\\][^/\\]+$/, '') ?? ''
  useEffect(() => {
    generation.current++
    inFlight.current.clear()
    setChildren(new Map())
    setErrors(new Map())
    setExpanded(new Set())
    // The root identifies workspace switches; routine tree patches preserve expansion.
  }, [root])

  const load = useCallback(async (path: string) => {
    if (inFlight.current.has(path)) return
    const current = generation.current
    inFlight.current.add(path)
    try {
      const result = await window.ide.listTree(path, 0)
      if (current !== generation.current) return
      setChildren((previous) => new Map(previous).set(path, result))
      setErrors((previous) => {
        const next = new Map(previous)
        next.delete(path)
        return next
      })
    } catch (error) {
      if (current === generation.current)
        setErrors((previous) => new Map(previous).set(path, String(error)))
    } finally {
      if (current === generation.current) inFlight.current.delete(path)
    }
  }, [])

  useEffect(
    () =>
      window.ide.onWorkspaceFsChanged(({ workspacePath, paths, path }) => {
        if (workspacePath !== root) return
        const changed = paths?.length ? paths : [path]
        for (const folder of expanded) {
          const rel = folder.slice(root.length + 1).replace(/\\/g, '/')
          if (changed.some((entry) => entry === rel || entry.startsWith(`${rel}/`)))
            void load(folder)
        }
      }),
    [root, expanded, load]
  )

  const rows = useMemo(() => {
    const result: Row[] = []
    const visit = (list: FileEntry[], level: number) => {
      for (const entry of list) {
        result.push({ entry, depth: level })
        if (entry.isDirectory && expanded.has(entry.path))
          visit(children.get(entry.path) ?? entry.children ?? [], level + 1)
      }
    }
    visit(entries, depth)
    return result
  }, [entries, expanded, children, depth])

  return (
    <div
      data-virtual-scroll
      style={{
        maxHeight: '50vh',
        height: Math.min(420, rows.length * 30),
        minHeight: 30,
        overflow: 'auto'
      }}
      role="tree"
      aria-label="Workspace files"
    >
      <VirtualList
        items={rows}
        itemKey={rowKey}
        estimate={30}
        overscan={240}
        renderItem={({ entry, depth: level }) => (
          <div
            className={`tree-item ${!entry.isDirectory && activePath === entry.path ? 'active' : ''}`}
            style={{ paddingLeft: 10 + level * 12, minHeight: 30 }}
            role="treeitem"
            aria-level={level + 1}
            aria-expanded={entry.isDirectory ? expanded.has(entry.path) : undefined}
          >
            <button
              style={{
                flex: 1,
                display: 'flex',
                gap: 6,
                minWidth: 0,
                padding: 0,
                background: 'transparent',
                textAlign: 'left'
              }}
              title={errors.get(entry.path) || entry.path}
              onClick={() => {
                if (!entry.isDirectory) {
                  onOpen(entry.path)
                  return
                }
                const opening = !expanded.has(entry.path)
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (opening) next.add(entry.path)
                  else next.delete(entry.path)
                  return next
                })
                if (opening) void load(entry.path)
              }}
              onContextMenu={(event) => {
                if (!entry.isDirectory && onAttach) {
                  event.preventDefault()
                  onAttach(entry.path)
                }
              }}
            >
              <span style={{ width: 12, opacity: 0.7 }}>
                {entry.isDirectory ? (expanded.has(entry.path) ? '▾' : '▸') : '·'}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.name}
                {errors.has(entry.path) ? ' — retry' : ''}
              </span>
            </button>
            {!entry.isDirectory && onAttach && (
              <button
                className="btn-ghost"
                title="Attach to agent"
                onClick={() => onAttach(entry.path)}
              >
                ↗
              </button>
            )}
          </div>
        )}
      />
    </div>
  )
})
