import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { VirtualList } from '@/components/VirtualList'
import { DocumentEditor, disposeClosedModels } from '@/features/editor/DocumentEditor'
import { seedDocument, updateDocument, documentText } from '@/state/documents'
import { chatStream, setAnswerBuffer } from '@/state/chat-stream'
import { useStore } from '@/state/store'
import { computeLineChanges } from '@/features/editor/diff-client'
import { FileTree } from '@/features/workspace/FileTree'
import type { editor } from 'monaco-editor'

declare global {
  interface Window {
    clientCheck: () => Promise<Record<string, number | boolean>>
  }
}
let directoryRequests = 0
Object.assign(window, {
  ide: {
    lspDidOpen: async () => ({ ok: true }),
    lspDidClose: async () => ({ ok: true }),
    onWorkspaceFsChanged: () => () => {},
    listTree: async () => {
      directoryRequests++
      return Array.from({ length: 10_000 }, (_, index) => ({
        name: `file-${index}.ts`,
        path: `/fixture/src/file-${index}.ts`,
        isDirectory: false
      }))
    }
  }
})
const folders = [{ name: 'src', path: '/fixture/src', isDirectory: true }]
const tick = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const key = (item: number) => String(item)
const initial = { '/a.ts': 'const first = 1\nconst second = 2', '/b.ts': 'const other = 3' }
for (const [path, content] of Object.entries(initial)) seedDocument({ path, content, dirty: false })
let switchFile: (path: keyof typeof initial) => void
let changeExternal: () => void
let evictRows: () => void
let parentRenders = 0
let editorMounts = 0
let mounted: editor.IStandaloneCodeEditor

function StreamView() {
  const state = useStore(chatStream)
  return <output id="stream-output">{state.answerBuffer}</output>
}
function Fixture() {
  parentRenders++
  const [path, setPath] = useState<keyof typeof initial>('/a.ts')
  const [contents, setContents] = useState(initial)
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [evictable, setEvictable] = useState(() => Array.from({ length: 400 }, (_, i) => i))
  evictRows = () => setEvictable((rows) => rows.slice(100))
  switchFile = setPath
  changeExternal = () => {
    seedDocument({ path: '/b.ts', content: 'external replacement', dirty: false })
    setContents((previous) => ({ ...previous, '/b.ts': 'external replacement' }))
    setDirty((previous) => ({ ...previous, '/b.ts': false }))
  }
  return (
    <>
      <StreamView />
      <div id="tree-check">
        <FileTree entries={folders} activePath={null} onOpen={() => {}} />
      </div>
      <div
        id="virtual-scroll"
        data-virtual-scroll
        style={{ height: 400, width: 500, overflow: 'auto' }}
      >
        <VirtualList
          items={Array.from({ length: 10_000 }, (_, index) => index)}
          itemKey={key}
          estimate={40}
          renderItem={(item) => (
            <div data-row={item} style={{ height: 30 + (item % 4) * 10 }}>
              Message {item}
            </div>
          )}
        />
      </div>
      <div
        id="virtual-evict"
        data-virtual-scroll
        style={{ height: 400, width: 500, overflow: 'auto' }}
      >
        <VirtualList
          items={evictable}
          itemKey={key}
          estimate={40}
          renderItem={(item) => (
            <div data-evict-row={item} style={{ height: 40 }}>
              Message {item}
            </div>
          )}
        />
      </div>
      <div style={{ width: 700, height: 300 }}>
        <DocumentEditor
          path={path}
          value={contents[path]}
          language="typescript"
          theme="vs-dark"
          dirty={!!dirty[path]}
          options={{ automaticLayout: true, minimap: { enabled: false } }}
          onChange={(value) => {
            updateDocument(path, value)
            setDirty((previous) => (previous[path] ? previous : { ...previous, [path]: true }))
          }}
          editorDidMount={(instance) => {
            mounted = instance
            editorMounts++
          }}
          editorWillUnmount={() => {}}
        />
      </div>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>
)
window.clientCheck = async () => {
  await tick()
  assert(mounted, 'Editor failed to mount')
  const scroll = document.getElementById('virtual-scroll')!
  const count = () => scroll.querySelectorAll('[data-row]').length
  assert(count() < 100, 'Virtual list mounted too many rows')
  scroll.scrollTop = scroll.scrollHeight
  scroll.dispatchEvent(new Event('scroll'))
  await tick()
  await tick()
  assert(scroll.querySelector('[data-row="9999"]'), 'Virtual scrolling did not reach the final row')
  assert(count() < 100, 'Scrolling grew the live DOM')
  const evicting = document.getElementById('virtual-evict')!
  evicting.scrollTop = 200 * 40
  evicting.dispatchEvent(new Event('scroll'))
  await tick()
  await tick()
  evictRows()
  await tick()
  await tick()
  const anchor = evicting.querySelector<HTMLElement>('[data-evict-row="200"]')
  assert(anchor, 'Evicting older rows lost the row being read')
  const drift = anchor!.getBoundingClientRect().top - evicting.getBoundingClientRect().top
  assert(Math.abs(drift) < 1, `Evicting older rows moved the reader by ${drift}px`)
  assert(Number(directoryRequests) === 0, 'Collapsed folders were loaded eagerly')
  document.querySelector<HTMLButtonElement>('#tree-check button')!.click()
  await tick()
  await tick()
  assert(Number(directoryRequests) === 1, 'Folder expansion did not issue one lazy directory read')
  assert(
    document.querySelectorAll('#tree-check [role="treeitem"]').length < 100,
    'Expanded folder mounted all files'
  )
  const baseline = parentRenders
  for (let index = 0; index < 20; index++) flushSync(() => setAnswerBuffer(`Token ${index}`))
  assert(parentRenders === baseline, 'Stream updates rendered the editor parent')
  const streamParentRenders = parentRenders - baseline
  assert(
    document.getElementById('stream-output')!.textContent === 'Token 19',
    'Stream subscriber missed the update'
  )
  const mountBaseline = editorMounts
  const sameEditor = mounted
  const modelA = mounted.getModel()!
  flushSync(() =>
    mounted.executeEdits('check', [
      { range: modelA.getFullModelRange(), text: initial['/a.ts'] + '\n// unsaved' }
    ])
  )
  assert(documentText('/a.ts').endsWith('// unsaved'), 'Immediate save would miss unsaved text')
  mounted.setPosition({ lineNumber: 2, column: 4 })
  flushSync(() => switchFile('/b.ts'))
  await tick()
  assert(
    mounted === sameEditor && editorMounts === mountBaseline,
    'Tab switch recreated the editor'
  )
  flushSync(() => switchFile('/a.ts'))
  await tick()
  assert(mounted.getModel() === modelA, 'Tab switch recreated the document model')
  assert(mounted.getValue().endsWith('// unsaved'), 'Tab switch lost unsaved text')
  assert(mounted.getPosition()?.lineNumber === 2, 'Tab switch lost the cursor position')
  flushSync(() => mounted.trigger('check', 'undo', null))
  assert(mounted.getValue() === initial['/a.ts'], 'Tab switch lost undo history')
  flushSync(() => switchFile('/b.ts'))
  flushSync(changeExternal)
  assert(
    mounted.getValue() === 'external replacement',
    'External changes did not reach the persistent model'
  )
  disposeClosedModels(['/b.ts'])
  assert(modelA.isDisposed(), 'Closing a tab leaked its model')
  const before = 'a\nb\nc',
    after = 'a\nchanged\nc'
  const diff = computeLineChanges(before, after)
  assert(computeLineChanges(before, after) === diff, 'Identical diff work was not deduplicated')
  assert(
    (await diff).some((change) => change.lines.includes('changed')),
    'Diff worker returned no insertion'
  )
  return {
    visibleRows: count(),
    visibleTreeRows: document.querySelectorAll('#tree-check [role="treeitem"]').length,
    streamParentRenders,
    editorReused: true,
    undoPreserved: true,
    diffWorker: true
  }
}
