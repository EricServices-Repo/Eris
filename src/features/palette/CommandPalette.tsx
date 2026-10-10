import { useEffect, useMemo, useState } from 'react'

export interface CommandItem {
  id: string
  label: string
  shortcut?: string
  run: () => void
}

interface Props {
  open: boolean
  commands: CommandItem[]
  onClose: () => void
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  const run = (cmd: CommandItem) => {
    onClose()
    cmd.run()
  }

  return (
    <div className="palette" onClick={onClose}>
      <div className="palette-box" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, filtered.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            }
            if (e.key === 'Enter' && filtered[index]) {
              e.preventDefault()
              run(filtered[index])
            }
          }}
        />
        <div className="palette-list">
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              className={`cmd-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(cmd)}
            >
              <span style={{ flex: 1 }}>{cmd.label}</span>
              {cmd.shortcut && <span className="badge">{cmd.shortcut}</span>}
            </button>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 12, color: 'var(--text-muted)' }}>No matching commands</div>
          )}
        </div>
      </div>
    </div>
  )
}
