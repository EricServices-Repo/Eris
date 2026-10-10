import { useCallback, useEffect, useRef, useState } from 'react'
import MonacoEditor, { monaco } from 'react-monaco-editor'
import type { editor as MonacoEditorNS } from 'monaco-editor'
import type { AppSettings } from '@/shared/settings-schema'
import type { PendingDiff } from '@/features/chat/DiffReview'

export interface OpenTab {
  path: string
  name: string
  content: string
  language: string
  dirty: boolean
}

interface Props {
  tabs: OpenTab[]
  activePath: string | null
  settings: AppSettings
  pendingPatch?: PendingDiff | null
  revealLine?: number | null
  /** When true, skip as-you-type ghost completes (chat owns the model). */
  chatBusy?: boolean
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onChange: (path: string, content: string) => void
  onAcceptPatch?: (id: string) => void
  onRejectPatch?: (id: string) => void
  onToggleBreakpoint?: (path: string, line: number) => void
  breakpoints?: Array<{ path: string; line: number }>
}

export function EditorArea({
  tabs,
  activePath,
  settings,
  pendingPatch,
  revealLine,
  chatBusy = false,
  onSelect,
  onClose,
  onChange,
  onAcceptPatch,
  onRejectPatch,
  onToggleBreakpoint,
  breakpoints = []
}: Props) {
  const active = tabs.find((t) => t.path === activePath) ?? null
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editInstruction, setEditInstruction] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [completeHint, setCompleteHint] = useState<string | null>(null)
  const ghostRef = useRef<string | null>(null)
  const decorationRef = useRef<string[]>([])
  const bpDecorationRef = useRef<string[]>([])
  const patchDecorationRef = useRef<string[]>([])
  const disposablesRef = useRef<monaco.IDisposable[]>([])
  const completeReqRef = useRef(0)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lspTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearGhost = useCallback(() => {
    const ed = editorRef.current
    ghostRef.current = null
    if (ed) {
      decorationRef.current = ed.deltaDecorations(decorationRef.current, [])
    }
  }, [])

  const applyMarkerList = useCallback(
    (
      path: string,
      diagnostics: Array<{
        path: string
        line: number
        column: number
        endLine?: number
        endColumn?: number
        severity: 'error' | 'warning' | 'info'
        message: string
      }>,
      owner: string
    ) => {
      const ed = editorRef.current
      const model = ed?.getModel()
      if (!model || activePath !== path) return
      monaco.editor.setModelMarkers(
        model,
        owner,
        diagnostics.map((d) => ({
          startLineNumber: d.line,
          startColumn: d.column || 1,
          endLineNumber: d.endLine || d.line,
          endColumn: d.endColumn || (d.column || 1) + 1,
          message: d.message,
          severity:
            d.severity === 'error'
              ? monaco.MarkerSeverity.Error
              : d.severity === 'warning'
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info
        }))
      )
    },
    [activePath]
  )

  const applyDiagnostics = useCallback(async (path: string) => {
    try {
      const result = await window.ide.getDiagnostics()
      const rel = path.includes('/') ? path.split('/').slice(-3).join('/') : path
      const forFile = result.diagnostics.filter(
        (d) =>
          path.endsWith(d.path) ||
          d.path === path ||
          path.endsWith('/' + d.path) ||
          rel.endsWith(d.path)
      )
      applyMarkerList(path, forFile, 'eris-tsc')
    } catch {
      // optional
    }
  }, [applyMarkerList])

  useEffect(() => {
    return window.ide.onLspDiagnostics(({ path, diagnostics }) => {
      applyMarkerList(path, diagnostics, 'eris-lsp')
    })
  }, [applyMarkerList])

  const syncBreakpoints = useCallback(() => {
    const ed = editorRef.current
    if (!ed || !active) return
    const forFile = breakpoints.filter(
      (b) => active.path.endsWith(b.path) || b.path === active.path || active.path.endsWith('/' + b.path)
    )
    bpDecorationRef.current = ed.deltaDecorations(
      bpDecorationRef.current,
      forFile.map((b) => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: 'eris-breakpoint-glyph',
          glyphMarginHoverMessage: { value: 'Breakpoint' }
        }
      }))
    )
  }, [active, breakpoints])

  const syncPatchDecorations = useCallback(() => {
    const ed = editorRef.current
    if (!ed || !active || !pendingPatch || pendingPatch.status !== 'pending') {
      if (ed) {
        patchDecorationRef.current = ed.deltaDecorations(patchDecorationRef.current, [])
      }
      return
    }
    const patchPath = pendingPatch.path.split(' → ')[0] || pendingPatch.path
    if (!(active.path.endsWith(patchPath) || active.path.endsWith('/' + patchPath))) {
      patchDecorationRef.current = ed.deltaDecorations(patchDecorationRef.current, [])
      return
    }
    // Highlight changed lines roughly by comparing before/after line counts
    const afterLines = (pendingPatch.after || '').split('\n').length
    patchDecorationRef.current = ed.deltaDecorations(patchDecorationRef.current, [
      {
        range: new monaco.Range(1, 1, Math.max(1, afterLines), 1),
        options: {
          isWholeLine: true,
          className: 'eris-patch-line',
          linesDecorationsClassName: 'eris-patch-gutter'
        }
      }
    ])
  }, [active, pendingPatch])

  useEffect(() => {
    syncBreakpoints()
  }, [syncBreakpoints])

  useEffect(() => {
    syncPatchDecorations()
  }, [syncPatchDecorations])

  useEffect(() => {
    if (!active) return
    const path = active.path
    const timer = window.setTimeout(() => {
      void applyDiagnostics(path)
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [active?.path, applyDiagnostics])

  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !revealLine || revealLine < 1) return
    ed.revealLineInCenter(revealLine)
    ed.setPosition({ lineNumber: revealLine, column: 1 })
  }, [revealLine, activePath])

  const runInlineEdit = useCallback(async () => {
    const ed = editorRef.current
    if (!ed || !active) return
    const model = ed.getModel()
    if (!model) return
    const sel = ed.getSelection()
    if (!sel) return
    const selection = model.getValueInRange(sel)
    const before = model.getValueInRange({
      startLineNumber: Math.max(1, sel.startLineNumber - 12),
      startColumn: 1,
      endLineNumber: sel.startLineNumber,
      endColumn: sel.startColumn
    })
    const after = model.getValueInRange({
      startLineNumber: sel.endLineNumber,
      startColumn: sel.endColumn,
      endLineNumber: Math.min(model.getLineCount(), sel.endLineNumber + 12),
      endColumn: model.getLineMaxColumn(
        Math.min(model.getLineCount(), sel.endLineNumber + 12)
      )
    })
    setEditBusy(true)
    setEditError(null)
    try {
      const result = await window.ide.aiInlineEdit({
        path: active.path,
        language: active.language,
        selection: selection || '',
        instruction: editInstruction.trim() || 'Improve this code',
        before,
        after
      })
      if (!result.ok || result.text == null) {
        setEditError(result.error || 'Edit failed')
        return
      }
      ed.executeEdits('eris-inline-edit', [
        { range: sel, text: result.text, forceMoveMarkers: true }
      ])
      onChange(active.path, ed.getValue())
      setEditOpen(false)
      setEditInstruction('')
    } finally {
      setEditBusy(false)
    }
  }, [active, editInstruction, onChange])

  const requestTabComplete = useCallback(async (opts?: { quiet?: boolean }) => {
    const ed = editorRef.current
    if (!ed || !active) return
    const model = ed.getModel()
    const pos = ed.getPosition()
    if (!model || !pos) return
    // Skip when there is a selection (user is not mid-type)
    const sel = ed.getSelection()
    if (sel && !sel.isEmpty()) return
    const offset = model.getOffsetAt(pos)
    const value = model.getValue()
    if (value.trim().length < 2) return
    clearGhost()
    const requestId = `c-${++completeReqRef.current}`
    if (!opts?.quiet) setCompleteHint('Completing…')
    void window.ide.aiCompleteCancel()
    const result = await window.ide.aiComplete({
      path: active.path,
      language: active.language,
      prefix: value.slice(0, offset),
      suffix: value.slice(offset),
      requestId
    })
    if (requestId !== `c-${completeReqRef.current}`) return
    if (!result.ok || !result.text) {
      if (!opts?.quiet) {
        setCompleteHint(result.error || 'No suggestion')
        setTimeout(() => setCompleteHint(null), 2500)
      }
      return
    }
    // Cursor may have moved — re-check
    const posNow = ed.getPosition()
    if (!posNow) return
    ghostRef.current = result.text
    const preview = result.text.split('\n')[0] || result.text
    decorationRef.current = ed.deltaDecorations(decorationRef.current, [
      {
        range: new monaco.Range(posNow.lineNumber, posNow.column, posNow.lineNumber, posNow.column),
        options: {
          after: {
            content: preview.slice(0, 80) + (result.text.includes('\n') ? '…' : ''),
            inlineClassName: 'eris-ghost-text'
          }
        }
      }
    ])
    setCompleteHint('Tab to accept · Esc to dismiss')
  }, [active, clearGhost])

  const scheduleInlineSuggest = useCallback(() => {
    if (!settings.editor.inlineSuggest || chatBusy) return
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    suggestTimerRef.current = setTimeout(() => {
      void requestTabComplete({ quiet: true })
    }, 450)
  }, [requestTabComplete, settings.editor.inlineSuggest, chatBusy])

  const acceptGhost = useCallback(() => {
    const ed = editorRef.current
    const text = ghostRef.current
    if (!ed || !text || !active) return false
    const pos = ed.getPosition()
    if (!pos) return false
    ed.executeEdits('eris-tab-complete', [
      {
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text,
        forceMoveMarkers: true
      }
    ])
    onChange(active.path, ed.getValue())
    clearGhost()
    setCompleteHint('Inserted')
    setTimeout(() => setCompleteHint(null), 1200)
    return true
  }, [active, clearGhost, onChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && active) {
        e.preventDefault()
        setEditOpen(true)
        setEditError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose()
      disposablesRef.current = []
    }
  }, [])

  const showPatchBar =
    pendingPatch &&
    pendingPatch.status === 'pending' &&
    active &&
    (active.path.endsWith(pendingPatch.path.split(' → ')[0] || '') ||
      active.path.endsWith('/' + (pendingPatch.path.split(' → ')[0] || '')))

  if (tabs.length === 0) {
    return (
      <div className="editor-area">
        <div className="editor-empty">
          Open a folder and select a file to start editing.
          <br />
          <span style={{ opacity: 0.75 }}>
            ⌘K edit · ⌥\ complete · F12 go to definition · gutter breakpoints
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-area">
      <div className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            className={`tab ${tab.path === activePath ? 'active' : ''}`}
            onClick={() => onSelect(tab.path)}
            title={tab.path}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.name}</span>
            {tab.dirty && <span className="dirty">●</span>}
            <span
              role="button"
              tabIndex={0}
              style={{ marginLeft: 6, opacity: 0.6 }}
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.path)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  onClose(tab.path)
                }
              }}
            >
              ×
            </span>
          </button>
        ))}
        <div className="editor-ai-actions">
          <button
            type="button"
            className="btn"
            disabled={!active}
            onClick={() => {
              setEditOpen(true)
              setEditError(null)
            }}
          >
            Edit ⌘K
          </button>
          <button
            type="button"
            className="btn"
            disabled={!active}
            onClick={() => void requestTabComplete()}
          >
            Complete ⌥\
          </button>
          <button
            type="button"
            className="btn"
            disabled={!active}
            title="Refresh TypeScript diagnostics"
            onClick={() => active && void applyDiagnostics(active.path)}
          >
            Diagnose
          </button>
          {completeHint && <span className="editor-ai-hint">{completeHint}</span>}
        </div>
      </div>
      {showPatchBar && pendingPatch && (
        <div className="inline-patch-bar">
          <strong>Agent change</strong>
          <span className="subtitle">{pendingPatch.path}</span>
          <div className="diff-actions" style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onAcceptPatch?.(pendingPatch.id)}
            >
              Accept
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onRejectPatch?.(pendingPatch.id)}
            >
              Reject
            </button>
          </div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {active && (
          <MonacoEditor
            key={active.path}
            language={active.language}
            theme={settings.editor.theme}
            value={active.content}
            onChange={(value) => {
              clearGhost()
              onChange(active.path, value ?? '')
              const text = value ?? ''
              if (lspTimerRef.current) clearTimeout(lspTimerRef.current)
              lspTimerRef.current = setTimeout(() => {
                void window.ide.lspDidChange({
                  path: active.path,
                  language: active.language,
                  text
                })
              }, 250)
              scheduleInlineSuggest()
            }}
            editorDidMount={(editor) => {
              editorRef.current = editor
              for (const d of disposablesRef.current) d.dispose()
              disposablesRef.current = []

              void window.ide.lspDidOpen({
                path: active.path,
                language: active.language,
                text: editor.getValue()
              })

              editor.onMouseDown((e) => {
                if (
                  e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
                  e.target.position &&
                  onToggleBreakpoint
                ) {
                  onToggleBreakpoint(active.path, e.target.position.lineNumber)
                }
              })

              const lang = active.language || 'typescript'

              disposablesRef.current.push(
                monaco.languages.registerHoverProvider(lang, {
                  provideHover: async (model, position) => {
                    const lsp = await window.ide.lspHover({
                      path: active.path,
                      line: position.lineNumber,
                      character: position.column
                    })
                    if (lsp.contents) {
                      return {
                        range: new monaco.Range(
                          position.lineNumber,
                          position.column,
                          position.lineNumber,
                          position.column
                        ),
                        contents: [{ value: lsp.contents }]
                      }
                    }
                    const word = model.getWordAtPosition(position)
                    if (!word) return null
                    const hover = await window.ide.languageHover(active.path, word.word)
                    if (!hover.contents) return null
                    return {
                      range: new monaco.Range(
                        position.lineNumber,
                        word.startColumn,
                        position.lineNumber,
                        word.endColumn
                      ),
                      contents: [{ value: hover.contents }]
                    }
                  }
                })
              )

              disposablesRef.current.push(
                monaco.languages.registerDefinitionProvider(lang, {
                  provideDefinition: async (model, position) => {
                    const lsp = await window.ide.lspDefinition({
                      path: active.path,
                      line: position.lineNumber,
                      character: position.column
                    })
                    let loc = lsp.locations[0]
                    if (!loc) {
                      const word = model.getWordAtPosition(position)
                      if (!word) return null
                      const defs = await window.ide.goToDefinition(word.word)
                      loc = defs.locations[0]
                    }
                    if (!loc) return null
                    const sameFile =
                      active.path.endsWith(loc.path) ||
                      active.path.endsWith('/' + loc.path) ||
                      loc.path === active.path
                    if (!sameFile) {
                      window.dispatchEvent(
                        new CustomEvent('eris:goto', {
                          detail: { path: loc.path, line: loc.line }
                        })
                      )
                      return null
                    }
                    return {
                      uri: model.uri,
                      range: new monaco.Range(loc.line, 1, loc.line, 1)
                    }
                  }
                })
              )

              disposablesRef.current.push(
                monaco.languages.registerCompletionItemProvider(lang, {
                  triggerCharacters: ['.', '"', "'", '/', '@'],
                  provideCompletionItems: async (model, position) => {
                    const lsp = await window.ide.lspCompletion({
                      path: active.path,
                      line: position.lineNumber,
                      character: position.column
                    })
                    if (!lsp.items.length) {
                      return { suggestions: [] }
                    }
                    const word = model.getWordUntilPosition(position)
                    const range = new monaco.Range(
                      position.lineNumber,
                      word.startColumn,
                      position.lineNumber,
                      word.endColumn
                    )
                    return {
                      suggestions: lsp.items.map((item, i) => ({
                        label: item.label,
                        kind: monaco.languages.CompletionItemKind.Text,
                        insertText: item.insertText || item.label,
                        detail: item.detail,
                        range,
                        sortText: String(i).padStart(4, '0')
                      }))
                    }
                  }
                })
              )

              editor.addCommand(monaco.KeyCode.F12, () => {
                void (async () => {
                  const model = editor.getModel()
                  const pos = editor.getPosition()
                  if (!model || !pos) return
                  const lsp = await window.ide.lspDefinition({
                    path: active.path,
                    line: pos.lineNumber,
                    character: pos.column
                  })
                  let loc = lsp.locations[0]
                  if (!loc) {
                    const word = model.getWordAtPosition(pos)
                    if (!word) return
                    const defs = await window.ide.goToDefinition(word.word)
                    loc = defs.locations[0]
                  }
                  if (!loc) {
                    setCompleteHint('No definition found')
                    setTimeout(() => setCompleteHint(null), 2000)
                    return
                  }
                  window.dispatchEvent(
                    new CustomEvent('eris:goto', {
                      detail: { path: loc.path, line: loc.line }
                    })
                  )
                })()
              })

              editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Backslash, () => {
                if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
                void requestTabComplete()
              })
              editor.addCommand(monaco.KeyCode.Tab, () => {
                if (ghostRef.current) {
                  acceptGhost()
                  return
                }
                editor.trigger('keyboard', 'type', {
                  text: ' '.repeat(settings.editor.tabSize || 2)
                })
              })
              editor.addCommand(monaco.KeyCode.Escape, () => {
                if (ghostRef.current) {
                  clearGhost()
                  setCompleteHint(null)
                  void window.ide.aiCompleteCancel()
                }
              })

              void applyDiagnostics(active.path)
              syncBreakpoints()
              syncPatchDecorations()
            }}
            options={{
              fontSize: settings.editor.fontSize,
              tabSize: settings.editor.tabSize,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 12 },
              glyphMargin: true
            }}
          />
        )}
        {editOpen && active && (
          <div className="inline-edit-panel">
            <div className="inline-edit-head">
              <strong>Inline edit</strong>
              <span className="subtitle">{active.name}</span>
            </div>
            <input
              autoFocus
              value={editInstruction}
              onChange={(e) => setEditInstruction(e.target.value)}
              placeholder="Describe the change (uses selection when present)"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void runInlineEdit()
                }
                if (e.key === 'Escape') setEditOpen(false)
              }}
            />
            {editError && (
              <div className="subtitle" style={{ color: 'var(--danger)' }}>
                {editError}
              </div>
            )}
            <div className="diff-actions" style={{ marginLeft: 0 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={editBusy}
                onClick={() => void runInlineEdit()}
              >
                {editBusy ? 'Editing…' : 'Apply'}
              </button>
              <button type="button" className="btn" onClick={() => setEditOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
