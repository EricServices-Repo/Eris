import { performanceQuantiles } from '@/shared/performance-budget'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { HistoricalMessages } from '@/features/chat/ChatPanel'
import { MarkdownMessage } from '@/features/chat/MarkdownMessage'
import { computeLineChanges } from '@/features/editor/diff-client'
import { chatStream, setAnswerBuffer } from '@/state/chat-stream'
import { useStore } from '@/state/store'
import type { ChatMessage } from '@/shared/settings-schema'
import '@/styles/global.css'
declare global {
  interface Window {
    runPerformance: (baseline?: boolean) => Promise<Record<string, unknown>>
  }
}
Object.assign(window, { ide: { getLatestChatJob: async () => null } })
const tick = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
const make = (i: number): ChatMessage => ({
  id: `m${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content:
    `needle-${i}: Explain this example.\n\n## Code\n\n\`\`\`ts\nexport const value = ${i}\n\`\`\`\n\n` +
    'A realistic paragraph about implementation, design, and verification. '.repeat(8),
  createdAt: i
})
const initial = Array.from({ length: 10000 }, (_, i) => make(i))
let setMessages: (fn: (previous: ChatMessage[]) => ChatMessage[]) => void, resetStop: () => void
let stopped = false,
  inputEvents = 0
function Stream() {
  const state = useStore(chatStream)
  return (
    <div id="perf-stream">
      <MarkdownMessage content={state.answerBuffer} plain />
    </div>
  )
}
function Fixture() {
  const [messages, update] = useState(initial),
    [stop, setStop] = useState(false)
  setMessages = update
  resetStop = () => setStop(false)
  stopped = stop
  return (
    <>
      <div
        className="agent-messages"
        data-virtual-scroll
        id="perf-scroll"
        style={{ height: 500, overflow: 'auto', display: 'block' }}
      >
        <div className="chat-messages">
          <HistoricalMessages
            searchOpen
            messages={messages}
            onOpenPath={() => {}}
            streaming={false}
          />
        </div>
      </div>
      <Stream />
      <textarea id="perf-input" aria-label="Fixture composer" onInput={() => inputEvents++} />
      <button id="perf-stop" onClick={() => setStop(true)}>
        {stop ? 'Stopped' : 'Stop'}
      </button>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
const quantiles = performanceQuantiles
const until = async (fn: () => boolean, waitingFor = 'its next state') => {
  for (let i = 0; i < 150; i++) {
    if (fn()) return
    await tick()
  }
  throw new Error(`Performance fixture did not settle: ${waitingFor}`)
}
window.runPerformance = async (baseline) => {
  await tick()
  const scroll = document.getElementById('perf-scroll')!,
    rows = () => scroll.querySelectorAll<HTMLElement>('[data-virtual-key]'),
    counts: number[] = [],
    anchorErrors: number[] = [],
    longTasks: number[] = []
  const observer = new PerformanceObserver((list) =>
    list.getEntries().forEach((e) => longTasks.push(e.duration))
  )
  observer.observe({ entryTypes: ['longtask'] })
  scroll.scrollTop = scroll.scrollHeight
  scroll.dispatchEvent(new Event('scroll'))
  await until(() => !!scroll.querySelector('[data-virtual-key="m9999"]'))
  counts.push(rows().length)
  scroll.scrollTop = scroll.scrollHeight / 2
  scroll.dispatchEvent(new Event('scroll'))
  await tick()
  await tick()
  // Rows mount a frame or more after a scroll; a loaded runner can take longer than two.
  const firstVisible = () =>
    [...rows()].find(
      (node) => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top + 5
    )
  for (let page = 0; page < 5; page++) {
    await until(() => !!firstVisible(), `a visible row before page ${page}`)
    const anchor = firstVisible()!,
      key = anchor.dataset.virtualKey,
      y = anchor.getBoundingClientRect().top
    flushSync(() =>
      setMessages((previous) => [
        ...Array.from({ length: 200 }, (_, i) => make(-1 - page * 200 - i)),
        ...previous
      ])
    )
    await tick()
    await tick()
    await until(
      () => [...rows()].some((n) => n.dataset.virtualKey === key),
      `anchor ${key} to return after page ${page}`
    )
    const after = [...rows()].find((n) => n.dataset.virtualKey === key)!
    anchorErrors.push(Math.abs(after.getBoundingClientRect().top - y))
    counts.push(rows().length)
  }
  const button = scroll.querySelector<HTMLButtonElement>('.msg-feedback button')
  button?.focus()
  const focused = document.activeElement
  const focusedKey = button?.closest<HTMLElement>('[data-virtual-key]')?.dataset.virtualKey
  await tick()
  const focusBefore = scroll
    .querySelector('[data-retained-focus]')
    ?.getAttribute('data-retained-focus')
  scroll.scrollTop = scroll.scrollHeight * 0.8
  scroll.dispatchEvent(new Event('scroll'))
  await tick()
  await tick()
  const focusPreserved = !!button && focused === document.activeElement && button.isConnected
  const focusDetails = {
    hadButton: !!button,
    before: focused?.tagName,
    after: document.activeElement?.tagName,
    key: focusedKey,
    connected: button?.isConnected,
    focusBefore,
    focusAfter: scroll.querySelector('[data-retained-focus]')?.getAttribute('data-retained-focus')
  }
  counts.push(rows().length)
  document.querySelector<HTMLTextAreaElement>('#perf-input')!.focus()
  const selected = scroll.querySelector('.user-text') ?? scroll.querySelector('.md-body')!,
    range = document.createRange()
  range.selectNodeContents(selected)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await tick()
  const selectedText = selection.toString()
  scroll.scrollTop = scroll.scrollHeight * 0.2
  scroll.dispatchEvent(new Event('scroll'))
  await tick()
  await tick()
  const selectionPreserved = !!selectedText && selection.toString() === selectedText
  selection.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  await tick()
  counts.push(rows().length)
  let searchPreserved = false
  let historySearchMs: number | null = null
  const search = document.querySelector<HTMLInputElement>('[data-history-search]')
  if (search) {
    const searchAt = performance.now()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(search, 'needle-7421:')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await until(
      () => !!document.querySelector<HTMLButtonElement>('[data-history-next]:not(:disabled)')
    )
    document.querySelector<HTMLButtonElement>('[data-history-next]')!.click()
    await until(() => !!scroll.querySelector('[data-virtual-key="m7421"]'))
    historySearchMs = performance.now() - searchAt
    counts.push(rows().length)
    searchPreserved = true
  }
  const heap: number[] = []
  const paint: number[] = [],
    stop: number[] = [],
    typing: number[] = [],
    diff: number[] = []
  let text = ''
  for (let i = 0; i < 20; i++) {
    const at = performance.now()
    text += 'x'.repeat(64)
    flushSync(() => setAnswerBuffer(text))
    await tick()
    paint.push(performance.now() - at)
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) heap.push(memory.usedJSHeapSize / 1024 ** 2)
  }
  const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  for (let i = 0; i < 5; i++) {
    const at = performance.now(),
      pending = computeLineChanges(before, before + `\nchanged ${i}`).then(() => {
        diff.push(performance.now() - at)
      })
    flushSync(resetStop)
    const stopAt = performance.now()
    document.querySelector<HTMLButtonElement>('#perf-stop')!.click()
    await tick()
    if (!stopped) throw new Error('Stop did not update')
    stop.push(performance.now() - stopAt)
    await pending
  }
  for (let i = 0; i < 20; i++) {
    const at = performance.now(),
      input = document.querySelector<HTMLTextAreaElement>('#perf-input')!
    input.value = `draft ${i}`
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
    await tick()
    typing.push(performance.now() - at)
  }
  observer.disconnect()
  const result = {
    fixtureVersion: 'eris-ui-perf-1',
    messages: 11000,
    messageChars: initial.reduce((n, m) => n + m.content.length, 0),
    pagesPrepended: 5,
    maxMountedRows: Math.max(...counts),
    maxAnchorErrorPx: Math.max(...anchorErrors),
    focusPreserved,
    focusDebug: focusDetails,
    selectionPreserved,
    searchPreserved,
    tokenToPaintMs: quantiles(paint),
    stopToPaintMs: quantiles(stop),
    typingToPaintMs: quantiles(typing),
    largeDiffWorkerMs: quantiles(diff),
    longTasks: quantiles(longTasks),
    longTaskCount: longTasks.length,
    longestRecordedTaskMs: quantiles([Math.max(0, ...longTasks)]),
    jsHeapMiB: quantiles(heap),
    jsHeapBytes:
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
    historySearchMs,
    inputEvents,
    liveModelCalls: 0
  }
  if (
    !baseline &&
    (!focusPreserved ||
      !selectionPreserved ||
      !searchPreserved ||
      result.maxMountedRows > 120 ||
      result.maxAnchorErrorPx > 8)
  )
    throw new Error('Interaction/DOM performance invariant failed: ' + JSON.stringify(result))
  return result
}
