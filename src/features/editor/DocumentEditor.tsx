import { useLayoutEffect, useRef } from 'react'
import { monaco } from 'react-monaco-editor'
import type { editor } from 'monaco-editor'
import { bindDocument, documentText, markDocumentChanged } from '@/state/documents'

type ModelEntry = { model: editor.ITextModel; view: editor.ICodeEditorViewState | null }
const models = new Map<string, ModelEntry>()
export function disposeClosedModels(paths: string[]): void {
  const open = new Set(paths)
  for (const [path, entry] of models)
    if (!open.has(path)) {
      entry.model.dispose()
      models.delete(path)
      void window.ide.lspDidClose(path)
    }
}
type Props = {
  path: string
  value: string
  language: string
  theme: string
  dirty: boolean
  options: editor.IStandaloneEditorConstructionOptions
  onChange: (value: string) => void
  editorDidMount: (editor: editor.IStandaloneCodeEditor) => void
  editorWillUnmount: () => void
}

/** One editor, one persistent model per open document, independent of React text state. */
export function DocumentEditor(props: Props) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null)
  const latest = useRef(props)
  latest.current = props
  const pending = useRef<{ flush: () => void; timer: ReturnType<typeof setTimeout> } | null>(null)
  const switching = useRef(false)
  const flush = () => {
    const update = pending.current
    if (update) {
      clearTimeout(update.timer)
      pending.current = null
      update.flush()
    }
  }
  useLayoutEffect(() => {
    const current = latest.current
    const uri = monaco.Uri.file(current.path)
    let entry = models.get(current.path)
    if (!entry) {
      entry = {
        model:
          monaco.editor.getModel(uri) ??
          monaco.editor.createModel(
            documentText(current.path, current.value),
            current.language,
            uri
          ),
        view: null
      }
      models.set(current.path, entry)
    }
    const ed = monaco.editor.create(container.current!, {
      ...current.options,
      model: entry.model,
      theme: current.theme
    })
    instance.current = ed
    current.editorDidMount(ed)
    const subscription = ed.onDidChangeModelContent(() => {
      if (switching.current) return
      const model = ed.getModel()
      if (!model) return
      const callback = latest.current.onChange
      const first = markDocumentChanged(latest.current.path)
      if (pending.current) {
        clearTimeout(pending.current.timer)
        pending.current = null
      }
      if (first) callback(model.getValue())
      else
        pending.current = { flush: () => callback(model.getValue()), timer: setTimeout(flush, 120) }
    })
    return () => {
      flush()
      const active = ed.getModel()
      if (active) {
        const cached = models.get(active.uri.fsPath)
        if (cached) cached.view = ed.saveViewState()
      }
      subscription.dispose()
      ed.dispose()
      instance.current = null
      latest.current.editorWillUnmount()
    }
  }, [])
  useLayoutEffect(() => {
    const ed = instance.current!
    flush()
    const previous = ed.getModel()
    if (previous && previous.uri.fsPath !== props.path) {
      const cached = models.get(previous.uri.fsPath)
      if (cached) cached.view = ed.saveViewState()
    }
    let entry = models.get(props.path)
    const desired = props.options.readOnly ? props.value : documentText(props.path, props.value)
    if (!entry) {
      const uri = monaco.Uri.file(props.path)
      entry = {
        model:
          monaco.editor.getModel(uri) ?? monaco.editor.createModel(desired, props.language, uri),
        view: null
      }
      models.set(props.path, entry)
    }
    switching.current = true
    if (previous !== entry.model) ed.setModel(entry.model)
    monaco.editor.setModelLanguage(entry.model, props.language)
    if (entry.model.getValue() !== desired) {
      ed.pushUndoStop()
      entry.model.pushEditOperations(
        [],
        [{ range: entry.model.getFullModelRange(), text: desired }],
        () => null
      )
      ed.pushUndoStop()
    }
    switching.current = false
    if (previous !== entry.model && entry.view) ed.restoreViewState(entry.view)
    const model = entry.model
    const release = bindDocument(props.path, () => model.getValue())
    return () => {
      flush()
      release()
    }
  }, [props.path, props.value, props.language, props.options.readOnly, props.dirty])
  useLayoutEffect(() => {
    const model = instance.current?.getModel()
    if (model)
      void window.ide.lspDidOpen({
        path: props.path,
        language: props.language,
        text: model.getValue()
      })
  }, [props.path, props.language])
  useLayoutEffect(() => {
    instance.current?.updateOptions(props.options)
  }, [props.options])
  useLayoutEffect(() => {
    monaco.editor.setTheme(props.theme)
  }, [props.theme])
  return <div ref={container} style={{ width: '100%', height: '100%' }} />
}
