import { useModels } from '@/hooks/useModels'
import type { ModelsStatus } from '@/shared/settings-schema'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatPanel, type ChatMode } from '@/features/chat/ChatPanel'
import { PanelActions } from '@/components/PanelActions'
import { LanguageTools } from '@/features/editor/LanguageTools'
import { ThinkingBlock } from '@/features/chat/ThinkingBlock'
import type { ChatThread } from '@/shared/settings-schema'
import '@/styles/global.css'

declare global {
  interface Window {
    uxCheck: () => Promise<Record<string, boolean>>
  }
}
const noop = () => {}
const thread: ChatThread = {
  id: 'ux',
  title: 'A long conversation title that should truncate without squeezing actions',
  model: 'fixture',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    { id: 'u', role: 'user', content: 'Find this needle', createdAt: Date.now() },
    {
      id: 'a',
      createdAt: Date.now(),
      role: 'assistant',
      content: 'A useful answer.',
      thinking: 'Inspected the project.',
      model: 'fixture'
    }
  ]
}
Object.assign(window, {
  ide: {
    getLatestChatJob: async () => null,
    lspCapabilities: async () => ({
      ready: false,
      reason: 'Language server unavailable or document not open'
    })
  }
})
function Fixture() {
  const [mode, setMode] = useState<ChatMode>('agent')
  return (
    <div id="layout-fixture" style={{ width: 640 }}>
      <div id="chat-fixture" style={{ height: 650 }}>
        <ChatPanel
          activeThread={thread}
          routeLabel={null}
          composerReady
          modelsOk
          streaming={false}
          chatError={null}
          openTabs={[]}
          mentionFiles={[]}
          attachments={[]}
          skills={[]}
          activeSkills={[]}
          chatMode={mode}
          onChatModeChange={setMode}
          models={[]}
          selectedModel="auto"
          onModelChange={noop}
          onNewChat={noop}
          onSend={noop}
          onStop={noop}
          queuedMessages={[]}
          onQueueMessage={noop}
          onRemoveQueued={noop}
          onAttachmentsChange={noop}
          onActiveSkillsChange={noop}
          onImportFiles={noop}
          onAttachOpenTab={noop}
          onOpenPath={noop}
          onOpenModelsSettings={noop}
          onOpenSkillsSettings={noop}
          onCreateSkill={noop}
          onDismissError={noop}
        />
      </div>
      <div className="editor-header" id="editor-fixture">
        <div className="tabs">
          {['long-file-name.ts', 'another-long-file.ts', 'third-file.ts'].map((name) => (
            <button className="tab" key={name}>
              {name}
            </button>
          ))}
        </div>
        <PanelActions label="Editor actions">
          <LanguageTools
            path="/fixture.ts"
            text=""
            position={() => ({ line: 0, character: 0 })}
            onApplied={noop}
            freeze={noop}
          />
        </PanelActions>
      </div>
      <div id="progress-fixture">
        <ThinkingBlock thinking="Inspecting files" status="Working" live />
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
const tick = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
function assert(v: unknown, reason: string): asserts v {
  if (!v) throw new Error(reason)
}
const button = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
async function checkModelReadiness() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let snapshot: ReturnType<typeof useModels> | undefined
  function ModelsFixture() {
    snapshot = useModels(null)
    return null
  }
  root.render(<ModelsFixture />)
  await tick()
  const current = () => snapshot!
  assert(!current().modelsKnown, 'Startup must distinguish unknown from an empty catalog')
  const ready: ModelsStatus = {
    ok: true,
    builtin: [],
    models: [{ name: 'builtin:composer-lite', source: 'builtin', ready: true }],
    connections: []
  }
  Object.assign(window.ide, {
    modelsStatus: async () => ready,
    listAgents: async () => {
      throw new Error('Project agents unavailable')
    }
  })
  try {
    await current().refreshModels()
    await tick()
    assert(
      current().ollamaOk && current().modelsKnown,
      'Agent listing failures must not hide ready models'
    )
    Object.assign(window.ide, {
      modelsStatus: async () => {
        throw new Error('IPC unavailable')
      }
    })
    await current().refreshModels()
    await tick()
    assert(
      current().ollamaOk && current().modelsError,
      'Failed refresh must preserve the last ready catalog'
    )
    let oldResponse!: (status: ModelsStatus) => void
    Object.assign(window.ide, {
      modelsStatus: () =>
        new Promise<ModelsStatus>((resolve) => {
          oldResponse = resolve
        })
    })
    const older = current().refreshModels()
    Object.assign(window.ide, { modelsStatus: async () => ready })
    await current().refreshModels()
    oldResponse({ ok: false, builtin: [], models: [], connections: [] })
    await older
    await tick()
    assert(
      current().ollamaOk && !current().modelsError,
      'Stale refresh must not overwrite a newer ready catalog'
    )
    Object.assign(window.ide, {
      modelsStatus: async () => ({ ok: false, builtin: [], models: [], connections: [] })
    })
    await current().refreshModels()
    await tick()
    assert(
      current().modelsKnown && !current().ollamaOk,
      'A successful empty catalog must still disable chat'
    )
  } finally {
    root.unmount()
    host.remove()
  }
}
window.uxCheck = async () => {
  await checkModelReadiness()
  await tick()
  assert(!document.querySelector('[data-history-search]'), 'Search must be hidden initially')
  assert(
    !document.querySelector('.message-details[open]'),
    'Saved run details must start collapsed'
  )
  assert(
    !document.querySelector('#progress-fixture .thinking-body'),
    'Live tool trace must start collapsed'
  )
  assert(
    document.querySelector('#progress-fixture .thinking-status-inline')?.textContent === 'Working',
    'Live status must remain visible'
  )
  const layout = document.getElementById('layout-fixture')!
  for (const width of [320, 420, 640, 1000]) {
    layout.style.width = `${width}px`
    await tick()
    const header = document.querySelector<HTMLElement>('.agent-header')!
    assert(header.scrollWidth <= header.clientWidth + 1, `Chat header overflow at ${width}`)
    const title = header.firstElementChild!.getBoundingClientRect(),
      actions = document.querySelector('.chat-header-actions')!.getBoundingClientRect()
    assert(title.right <= actions.left + 1, `Title collides with actions at ${width}`)
    button('Find in conversation').click()
    await tick()
    const search = document.querySelector<HTMLInputElement>('[data-history-search]')!
    assert(document.activeElement === search, 'Search must receive focus')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(search, 'needle')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    await tick()
    assert(
      !document.querySelector<HTMLButtonElement>('[data-history-next]')?.disabled,
      'Search must find loaded messages'
    )
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    await tick()
    assert(!document.querySelector('[data-history-search]'), 'Escape must close search')
    assert(document.activeElement === button('Find in conversation'), 'Search must return focus')
    const summary = button('Editor actions')
    summary.click()
    await tick()
    const popup = document.querySelector<HTMLElement>('#editor-fixture .panel-actions-content')!
    assert(popup.getBoundingClientRect().width > 0, 'Editor actions must be discoverable')
    assert(popup.scrollWidth <= popup.clientWidth + 1, `Editor tools overflow at ${width}`)
    assert(popup.getBoundingClientRect().left >= 0, `Editor popup clipped at ${width}`)
    const refresh = popup.querySelector<HTMLButtonElement>('button')!
    refresh.focus()
    refresh.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    await tick()
    assert(!summary.parentElement?.hasAttribute('open'), 'Escape must close editor actions')
    assert(document.activeElement === summary, 'Editor actions must return focus')
    const editor = document.getElementById('editor-fixture')!
    assert(editor.getBoundingClientRect().height < 64, `Editor toolbar too tall at ${width}`)
  }
  return {
    modelReadiness: true,
    responsiveHeaders: true,
    optionalSearch: true,
    searchFocusReturn: true,
    editorMenu: true,
    collapsedDiagnostics: true,
    liveStatus: true
  }
}
