import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalNote {
  id: number
  text: string
}

interface Props {
  open: boolean
  workspacePath: string | null
  /** Agent / verify output, replayed when the terminal mounts */
  notes: TerminalNote[]
  onClose: () => void
}

function writeNote(term: Terminal, text: string) {
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.length) term.writeln(`\x1b[90m${line}\x1b[0m`)
  }
}

export function TerminalPanel({ open, workspacePath, notes, onClose }: Props) {
  const notesRef = useRef(notes)
  notesRef.current = notes
  const lastNoteIdRef = useRef(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!open || !workspacePath || !hostRef.current) return

    let disposed = false
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        selectionBackground: '#264f78'
      },
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const offData = window.ide.onPtyData((data) => {
      term.write(data)
    })
    const offExit = window.ide.onPtyExit(({ exitCode }) => {
      term.writeln(`\r\n[process exited: ${exitCode}]`)
      setReady(false)
    })
    for (const note of notesRef.current) writeNote(term, note.text)
    lastNoteIdRef.current = notesRef.current[notesRef.current.length - 1]?.id ?? 0

    const dataDisp = term.onData((data) => {
      void window.ide.ptyWrite(data)
    })

    const boot = async () => {
      const cols = term.cols
      const rows = term.rows
      const result = await window.ide.ptyEnsure({ cols, rows })
      if (disposed) return
      if (!result.ok) {
        setError(result.error || 'Failed to start terminal')
        term.writeln(`\r\n${result.error || 'Failed to start terminal'}`)
        return
      }
      setError(null)
      setReady(true)
      term.focus()
    }
    void boot()

    const onResize = () => {
      try {
        fit.fit()
        void window.ide.ptyResize({ cols: term.cols, rows: term.rows })
      } catch {
        // ignore
      }
    }
    const ro = new ResizeObserver(() => onResize())
    ro.observe(hostRef.current)

    return () => {
      disposed = true
      offData()
      offExit()
      dataDisp.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setReady(false)
    }
  }, [open, workspacePath])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    for (const note of notes) {
      if (note.id > lastNoteIdRef.current) writeNote(term, note.text)
    }
    lastNoteIdRef.current = notes[notes.length - 1]?.id ?? lastNoteIdRef.current
  }, [notes])

  if (!open) return null

  return (
    <div className="terminal-panel terminal-panel-pty">
      <div className="terminal-bar">
        <strong>Terminal</strong>
        {ready && <span className="thinking-status-inline">interactive</span>}
        {error && <span className="thinking-status-inline">{error}</span>}
        <div className="diff-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void window.ide.ptyKill()
              if (workspacePath) {
                void window.ide.ptyEnsure({
                  cols: termRef.current?.cols ?? 80,
                  rows: termRef.current?.rows ?? 24
                })
              }
            }}
          >
            Restart
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Editor
          </button>
        </div>
      </div>
      <div className="terminal-xterm-host" ref={hostRef} />
    </div>
  )
}
