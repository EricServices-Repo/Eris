import { PanelActions } from '@/components/PanelActions'
import { ContextMemoryInspector } from './ContextMemoryInspector'
import { useRequestFocus } from '@/hooks/useDialogFocus'
import { ChatTaskTimeline } from './TaskTimeline'
import { ImageMessage } from './ImageMessage'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatDelegation,
  ChatMessage,
  ChatThread,
  ModelInfo,
  SkillRecord
} from '@/shared/settings-schema'
import { CHAT_AGENT_CONTRACTS } from '@/shared/agent-contract'
import { pathBasename } from '@/shared/paths'
import { ThinkingBlock, type ToolActivityItem } from './ThinkingBlock'
import { AnswerFeedback } from './AnswerFeedback'
import { MarkdownMessage } from './MarkdownMessage'
import { chatStream } from '@/state/chat-stream'
import { useStore } from '@/state/store'
import { VirtualList } from '@/components/VirtualList'
import { searchLoadedHistory } from '@/shared/chat-history-search'
import type { historyView } from '@/shared/chat-history-window'

export type { ToolActivityItem }
export type ChatMode = 'ask' | 'agent'

export interface ChatAttachment {
  path: string
  name: string
}

export interface ActiveSkillRef {
  id: string
  name: string
}

export interface MentionCandidate {
  path: string
  name: string
}

export interface QueuedChatMessage {
  id: string
  text: string
  attachments: ChatAttachment[]
  skillIds: string[]
}

export const MAX_QUEUED_MESSAGES = 3

const messageKey = (message: ChatMessage) => message.id
const EMPTY_MESSAGES: ChatMessage[] = []

export const HistoricalMessages = memo(function HistoricalMessages({
  messages,
  onOpenPath,
  onRerouteLast,
  streaming,
  searchOpen = false,
  onCloseSearch,
  revealMessage = null
}: {
  messages: ChatMessage[]
  onOpenPath: (path: string) => void
  onRerouteLast?: (route: 'tools' | 'answer') => void
  streaming: boolean
  searchOpen?: boolean
  onCloseSearch?: () => void
  revealMessage?: { key: string; request: number } | null
}) {
  const visible = useMemo(() => messages.filter((message) => message.role !== 'system'), [messages])
  const [query, setQuery] = useState(''),
    [hits, setHits] = useState<string[]>([]),
    [searching, setSearching] = useState(false),
    [match, setMatch] = useState(-1),
    [reveal, setReveal] = useState<{ key: string; request: number } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(Boolean(query.trim()))
      setHits([])
      setMatch(-1)
      void searchLoadedHistory(visible, query, controller.signal)
        .then((ids) => {
          if (!controller.signal.aborted) {
            setHits(ids)
            setSearching(false)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [visible, query])
  useEffect(() => {
    if (revealMessage)
      setReveal((previous) => ({
        key: revealMessage.key,
        request: (previous?.request ?? 0) + 1
      }))
  }, [revealMessage])
  const navigate = (direction: number) => {
    if (!hits.length) return
    window.getSelection()?.removeAllRanges()
    const next =
      match < 0
        ? direction > 0
          ? 0
          : hits.length - 1
        : (match + direction + hits.length) % hits.length
    setMatch(next)
    setReveal((previous) => ({ key: hits[next], request: (previous?.request ?? 0) + 1 }))
  }

  const questions = useMemo(() => {
    let question = ''
    return new Map(
      visible.map((message) => {
        if (message.role === 'user') question = message.content
        return [message.id, question]
      })
    )
  }, [visible])
  return (
    <>
      {searchOpen && (
        <div className="chat-history-search" role="search" aria-label="Search loaded conversation">
          <label>
            <span className="sr-only">Search loaded messages</span>
            <input
              autoFocus
              placeholder="Find in conversation…"
              data-history-search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  onCloseSearch?.()
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  navigate(e.shiftKey ? -1 : 1)
                }
              }}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!hits.length}
            onClick={() => navigate(-1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn"
            data-history-next
            disabled={!hits.length}
            onClick={() => navigate(1)}
          >
            Next
          </button>
          <span role="status">
            {searching
              ? 'Searching…'
              : query
                ? `${hits.length} matches${match >= 0 ? ` · ${match + 1}` : ''}`
                : 'Loaded history'}
          </span>
          {onCloseSearch && (
            <button
              type="button"
              className="btn"
              aria-label="Close conversation search"
              onClick={onCloseSearch}
            >
              ×
            </button>
          )}
        </div>
      )}
      <VirtualList
        preserveInteraction
        semanticLabel="Conversation messages"
        reveal={reveal}
        items={visible}
        itemKey={messageKey}
        renderItem={(message, index) => (
          <div className={`chat-message-row ${message.role}`} style={{ paddingBottom: 12 }}>
            <div className={`msg ${message.role}`}>
              <span className="role">{message.role}</span>
              {message.role === 'assistant' ? (
                message.content && (
                  <div className="msg-summary">
                    <MarkdownMessage content={message.content} onOpenPath={onOpenPath} />
                  </div>
                )
              ) : (
                <div className="user-text">{message.content}</div>
              )}
              {message.assets?.map((asset) => (
                <ImageMessage key={asset.id} asset={asset} />
              ))}
              {message.role === 'assistant' &&
              (message.thinking ||
                message.model ||
                message.agentName ||
                message.delegations?.length) ? (
                <details className="message-details">
                  <summary>Run details</summary>
                  <p className="message-model">
                    {[message.agentName, message.model].filter(Boolean).join(' · ')}
                  </p>
                  {message.thinking && <ThinkingBlock thinking={message.thinking} defaultOpen />}
                  {!!message.delegations?.length && <DelegationCards items={message.delegations} />}
                </details>
              ) : null}
              {message.role === 'assistant' && (
                <AnswerFeedback message={message} question={questions.get(message.id) || ''} />
              )}
              {message.role === 'assistant' &&
                index === visible.length - 1 &&
                !streaming &&
                onRerouteLast && (
                  <details className="msg-reroute message-details">
                    <summary>Adjust routing</summary>
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => onRerouteLast('tools')}
                    >
                      Needed tools
                    </button>
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => onRerouteLast('answer')}
                    >
                      Just a question
                    </button>
                  </details>
                )}
            </div>
          </div>
        )}
      />
    </>
  )
})

interface SlashItem {
  id: string
  command: string
  label: string
  hint: string
  kind: 'action' | 'skill'
  skillId?: string
}

interface Props {
  workspacePath?: string | null
  activeThread: ChatThread | null
  onLoadEarlier?: () => Promise<void>
  onLoadNewer?: () => Promise<void>
  onJumpToLatest?: () => void
  /** Older pages plus the live tail, as produced by historyView. */
  history?: ReturnType<typeof historyView>
  onOpenMessage?: (ordinal: number) => Promise<string | null>
  routeLabel: string | null
  composerReady: boolean
  /** True when any chat backend is ready (builtin or Ollama/API connection). */
  modelsKnown?: boolean
  modelsError?: string | null
  modelsOk?: boolean
  streaming: boolean
  chatError: string | null
  delegations?: ChatDelegation[]
  openTabs: Array<{ path: string; name: string }>
  mentionFiles: MentionCandidate[]
  attachments: ChatAttachment[]
  skills: SkillRecord[]
  activeSkills: ActiveSkillRef[]
  chatMode: ChatMode
  onChatModeChange: (mode: ChatMode) => void
  models: ModelInfo[]
  selectedModel: string
  onModelChange: (model: string) => void
  onNewChat: () => void
  onSend: (text: string, attachments: ChatAttachment[], skillIds: string[]) => void
  onStop: () => void
  queuedMessages: QueuedChatMessage[]
  onQueueMessage: (text: string, attachments: ChatAttachment[], skillIds: string[]) => void
  onRemoveQueued: (id: string) => void
  onAttachmentsChange: (files: ChatAttachment[]) => void
  onActiveSkillsChange: (skills: ActiveSkillRef[]) => void
  onImportFiles: () => void
  onAttachOpenTab: (path: string) => void
  onOpenPath: (path: string) => void
  onOpenModelsSettings: () => void
  onOpenSkillsSettings: () => void
  onCreateSkill: () => void
  onDismissError: () => void
  pendingApproval?: PendingCommandApproval | null
  onApprovalDecision?: (approvalId: string, decision: 'allow' | 'always' | 'deny') => void
  pendingQuestion?: PendingUserQuestion | null
  onQuestionReply?: (questionId: string, reply: string | null) => void
  memoryNotice?: {
    kind: 'updated' | 'proposal'
    preview: string
    note?: string
    summary?: string
  } | null
  onMemoryRemember?: () => void
  onMemoryDismiss?: () => void
  onMemoryUndo?: () => void
  /** Re-run the last user message with a forced route */
  onRerouteLast?: (intent: 'tools' | 'answer') => void
  /** Live session checkpoints while the current agent run is streaming. */
  liveSessionSteps?: Array<{ step: number; summary: string; opThrough: number }>
}

export interface PendingCommandApproval {
  approvalId: string
  kind: 'run' | 'push' | 'mcp'
  command: string
  toolName?: string
  canAlwaysAllow?: boolean
  queuedCount?: number
}

export interface PendingUserQuestion {
  questionId: string
  question: string
  choices?: string[]
  timeoutMs: number
}

function parseAtQuery(draft: string, caret: number): { query: string; start: number } | null {
  const before = draft.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && /[\w./-]/.test(before[at - 1]!)) return null
  const token = before.slice(at + 1)
  if (token.includes(' ') || token.includes('\n')) return null
  return { query: token.toLowerCase(), start: at }
}

/** Slash menu while first line is `/query` with no space yet. */
function parseSlashQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  if (draft.includes('\n')) return null
  const token = draft.slice(1)
  if (token.includes(' ')) return null
  return token.toLowerCase()
}

function InlineAgentQuestion({
  question,
  onReply
}: {
  question: PendingUserQuestion
  onReply: (reply: string | null) => void
}) {
  const [draft, setDraft] = useState('')
  const questionRef = useRequestFocus(question.questionId)
  const timeoutMs = Math.max(1000, question.timeoutMs || 5 * 60_000)

  const submit = (text: string | null) => {
    onReply(text)
  }

  return (
    <div ref={questionRef} className="question-card" role="form" aria-label="Agent question">
      <div className="question-timeout-track" aria-hidden>
        <div className="question-timeout-bar" style={{ animationDuration: `${timeoutMs}ms` }} />
      </div>
      <div className="question-title">Composer needs a quick answer</div>
      <div className="question-text">{question.question}</div>
      {question.choices && question.choices.length > 0 && (
        <div className="question-choices">
          {question.choices.map((c) => (
            <button key={c} type="button" className="btn" onClick={() => submit(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <form
        className="question-reply-row"
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft.trim() || null)
        }}
      >
        <input
          data-initial-focus
          aria-label="Reply to agent question"
          className="question-reply-input"
          value={draft}
          placeholder="Type a reply…"
          lang="en"
          spellCheck
          autoCorrect="on"
          autoCapitalize="sentences"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
          Reply
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => submit(null)}
          title="Continue without answering"
        >
          Skip
        </button>
      </form>
      <div className="question-hint">Continues automatically if you don’t reply</div>
    </div>
  )
}

function DelegationCards({ items }: { items: ChatDelegation[] }) {
  if (items.length === 0) return null
  return (
    <div className="delegation-list">
      {items.map((item) => (
        <section key={item.id} className={`delegation-card is-${item.status}`}>
          <header>
            <strong>{item.agentName}</strong>
            <span>{item.status === 'running' ? 'working' : item.status}</span>
          </header>
          <p>{item.goal}</p>
          {item.tools.length > 0 && (
            <ul>
              {item.tools.map((tool, index) => (
                <li key={`${tool.name}-${index}`}>
                  {tool.name}
                  {tool.path ? ` ${tool.path}` : ''} · {tool.status}
                </li>
              ))}
            </ul>
          )}
          {item.result && <p className="delegation-result">{item.result}</p>}
        </section>
      ))}
    </div>
  )
}

export function ChatPanel({
  workspacePath = null,
  activeThread,
  onLoadEarlier,
  onLoadNewer,
  onJumpToLatest,
  history,
  onOpenMessage,
  routeLabel,
  composerReady,
  modelsOk = false,
  modelsKnown = true,
  modelsError = null,
  streaming,
  chatError,
  delegations = [],
  openTabs,
  mentionFiles,
  attachments,
  skills,
  activeSkills,
  chatMode,
  onChatModeChange,
  models,
  selectedModel,
  onModelChange,
  onNewChat,
  onSend,
  onStop,
  queuedMessages,
  onQueueMessage,
  onRemoveQueued,
  onAttachmentsChange,
  onActiveSkillsChange,
  onImportFiles,
  onAttachOpenTab,
  onOpenPath,
  onOpenModelsSettings,
  onOpenSkillsSettings,
  onCreateSkill,
  onDismissError,
  pendingApproval = null,
  onApprovalDecision,
  pendingQuestion = null,
  onQuestionReply,
  memoryNotice = null,
  onMemoryRemember,
  onMemoryDismiss,
  onMemoryUndo,
  onRerouteLast,
  liveSessionSteps = []
}: Props) {
  const { thinkingBuffer, answerBuffer, agentStatus, toolActivity } = useStore(chatStream)
  const [searchOpen, setSearchOpen] = useState(false)
  const [revealMessage, setRevealMessage] = useState<{ key: string; request: number } | null>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const closeSearch = () => {
    setSearchOpen(false)
    searchButton.current?.focus()
  }
  useEffect(() => setSearchOpen(false), [activeThread?.id])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const loadHistory = (load: () => Promise<void>) => {
    setLoadingHistory(true)
    setHistoryError(null)
    void load()
      .catch((error) => setHistoryError(String(error)))
      .finally(() => setLoadingHistory(false))
  }
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [atIndex, setAtIndex] = useState(0)
  const [caret, setCaret] = useState(0)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRootRef = useRef<HTMLElement | null>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const approvalRef = useRequestFocus(pendingApproval?.approvalId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottomRef = useRef(true)
  const scrollRafRef = useRef(0)

  useEffect(() => {
    if (!attachMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!attachMenuRef.current?.contains(e.target as Node)) setAttachMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [attachMenuOpen])

  useEffect(() => {
    const el = bottomRef.current?.closest<HTMLElement>('.agent-messages')
    if (!el) return
    stickToBottomRef.current = true
    scrollRootRef.current = el
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = dist < 96
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [activeThread?.id])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      // Instant during stream — smooth scroll fights token paint and feels laggy.
      bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
    })
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [
    activeThread?.messages,
    thinkingBuffer,
    answerBuffer,
    routeLabel,
    chatError,
    toolActivity,
    streaming
  ])

  const slashQuery = parseSlashQuery(draft)
  const atQuery = parseAtQuery(draft, caret)

  const atItems = useMemo(() => {
    if (!atQuery) return []
    const pool = [...openTabs.map((t) => ({ path: t.path, name: t.name })), ...mentionFiles]
    const seen = new Set<string>()
    const uniq = pool.filter((p) => {
      if (seen.has(p.path)) return false
      seen.add(p.path)
      return true
    })
    if (!atQuery.query) return uniq.slice(0, 12)
    return uniq
      .filter(
        (p) =>
          p.path.toLowerCase().includes(atQuery.query) ||
          p.name.toLowerCase().includes(atQuery.query)
      )
      .slice(0, 12)
  }, [atQuery, openTabs, mentionFiles])

  useEffect(() => {
    setAtIndex(0)
  }, [atQuery?.query, atItems.length])

  const applyAtItem = (item: MentionCandidate) => {
    if (!atQuery) return
    const before = draft.slice(0, atQuery.start)
    const after = draft.slice(caret)
    const insert = `@${item.path} `
    const next = `${before}${insert}${after}`
    setDraft(next)
    const pos = before.length + insert.length
    setCaret(pos)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
    })
    if (!attachments.some((a) => a.path === item.path)) {
      onAttachmentsChange([...attachments, { path: item.path, name: item.name }])
    }
  }

  const slashItems = useMemo((): SlashItem[] => {
    if (slashQuery === null) return []
    const actions: SlashItem[] = [
      {
        id: 'image',
        command: '/image',
        label: 'Generate image',
        hint: 'Create an image with your configured image provider',
        kind: 'action'
      },
      {
        id: 'create-skill',
        command: '/create-skill',
        label: 'Create skill',
        hint: 'Draft a chat prompt — saved outside the project by default',
        kind: 'action'
      },
      {
        id: 'skills',
        command: '/skills',
        label: 'Manage skills',
        hint: 'Open Skills settings',
        kind: 'action'
      }
    ]
    const skillItems: SlashItem[] = skills.map((s) => ({
      id: `skill-${s.scope}-${s.id}`,
      command: `/${s.id}`,
      label: s.name,
      hint: s.description || `${s.scope} skill`,
      kind: 'skill',
      skillId: s.id
    }))
    const all = [...actions, ...skillItems]
    if (!slashQuery) return all
    return all.filter(
      (item) =>
        item.command.slice(1).startsWith(slashQuery) ||
        item.label.toLowerCase().includes(slashQuery) ||
        item.id.toLowerCase().includes(slashQuery)
    )
  }, [skills, slashQuery])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery, slashItems.length])

  const applySlashItem = (item: SlashItem) => {
    if (item.kind === 'action') {
      if (item.id === 'image') {
        setDraft('/image ')
        textareaRef.current?.focus()
        return
      }
      if (item.id === 'create-skill') {
        setDraft(
          [
            'Create a user-scope skill (save outside this project with write_skill, scope "user").',
            '',
            'Name: ',
            'Description (when to use it): ',
            '',
            'Instructions for the agent:',
            '- '
          ].join('\n')
        )
        setSlashIndex(0)
        return
      }
      setDraft('')
      if (item.id === 'skills') onOpenSkillsSettings()
      else onCreateSkill()
      return
    }
    if (item.skillId) {
      const skill = skills.find((s) => s.id === item.skillId)
      if (skill && !activeSkills.some((a) => a.id === skill.id)) {
        onActiveSkillsChange([...activeSkills, { id: skill.id, name: skill.name }])
      }
    }
    setDraft('')
  }

  const canCompose = Boolean(draft.trim()) || attachments.length > 0 || activeSkills.length > 0
  const queueFull = queuedMessages.length >= MAX_QUEUED_MESSAGES

  const modelOptions = useMemo(() => {
    const ready = models.filter((m) => m.ready === true)
    const byName = new Map<string, ModelInfo>()
    byName.set('auto', { name: 'auto', ready: true, source: 'builtin' })
    byName.set('builtin:composer-lite', {
      name: 'builtin:composer-lite',
      ready: composerReady,
      source: 'builtin'
    })
    byName.set('builtin:composer', {
      name: 'builtin:composer',
      ready: true,
      source: 'builtin'
    })
    for (const model of ready) byName.set(model.name, model)
    if (selectedModel && selectedModel !== 'auto' && !byName.has(selectedModel)) {
      byName.set(selectedModel, {
        name: selectedModel,
        ready: false,
        source: selectedModel.startsWith('local:')
          ? 'local'
          : selectedModel.startsWith('builtin:')
            ? 'builtin'
            : 'connection'
      })
    }
    const auto = byName.get('auto')!
    byName.delete('auto')
    return [auto, ...byName.values()]
  }, [models, selectedModel, composerReady])

  const modelLabel = (m: ModelInfo): string => {
    if (m.name === 'auto') return 'Auto'
    if (m.name === 'builtin:composer-lite') return 'Composer Lite'
    if (m.name === 'builtin:composer') return 'Composer Full'
    if (m.source === 'builtin') return m.name.replace(/^builtin:/, '')
    if (m.source === 'local') return m.name.replace(/^local:/, '')
    return m.name
  }

  const modelDataHint = (m: ModelInfo): string => {
    if (m.name === 'auto')
      return 'Eris selects a ready model for this task. When outcome routing is enabled, saved run outcomes and eval scores can influence the choice. The selected provider may receive your prompt and attached project context.'
    if (m.ready === false)
      return 'This model is not currently ready. Reconnect or enable its provider in Settings → Models.'
    if (m.source === 'builtin' || m.source === 'local')
      return 'Runs on this device. Prompts and attached files stay local to Eris.'
    const connection = m.connectionId
      ? models.find((candidate) => candidate.connectionId === m.connectionId)
      : undefined
    return `Connected provider${connection?.connectionId ? ` (${connection.connectionId})` : ''}. Prompts and attached project context are sent to that provider.`
  }

  const selectValue = modelOptions.some((m) => m.name === selectedModel)
    ? selectedModel
    : modelOptions[0]?.name || 'builtin:composer-lite'

  useEffect(() => {
    if (selectedModel === 'auto') return
    if (selectValue && selectValue !== selectedModel) onModelChange(selectValue)
  }, [selectValue, selectedModel, onModelChange])

  const submit = () => {
    const text = draft.trim()
    if (!canCompose) return
    if (slashQuery !== null && slashItems.length > 0) return
    const payload = text || 'Please follow the attached skills and files.'
    const skillIds = activeSkills.map((s) => s.id)
    if (streaming) {
      if (queueFull) return
      setDraft('')
      onQueueMessage(payload, attachments, skillIds)
      onAttachmentsChange([])
      onActiveSkillsChange([])
      return
    }
    setDraft('')
    onSend(payload, attachments, skillIds)
  }

  const removeAttachment = (path: string) => {
    onAttachmentsChange(attachments.filter((a) => a.path !== path))
  }

  return (
    <div
      className="agent-center"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'f' &&
          activeThread?.messages.length
        ) {
          event.preventDefault()
          setSearchOpen(true)
        }
      }}
    >
      <div className="panel-header agent-header">
        <span title={activeThread?.title || 'Agent'}>{activeThread?.title || 'Agent'}</span>
        <div className="chat-header-actions">
          <select
            className="chat-mode-select"
            aria-label="Task permissions"
            value={chatMode}
            onChange={(e) => onChatModeChange(e.target.value as ChatMode)}
          >
            <option value="ask">Ask</option>
            <option value="agent">Agent</option>
          </select>
          <button
            ref={searchButton}
            type="button"
            className="btn btn-ghost chat-find-button"
            aria-label="Find in conversation"
            title="Find in conversation"
            aria-expanded={searchOpen}
            disabled={!activeThread?.messages.length}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 4.5 4.5" />
            </svg>
          </button>
          <PanelActions label="Chat options">
            <button className="btn" onClick={onNewChat}>
              New chat
            </button>
            {activeThread && (
              <ContextMemoryInspector
                key={`${workspacePath ?? 'global'}:${activeThread.id}`}
                threadId={activeThread.id}
                workspacePath={workspacePath}
                rendererBytes={history?.bytes}
                model={selectedModel}
                onOpenMessage={
                  onOpenMessage &&
                  ((ordinal) =>
                    void onOpenMessage(ordinal).then((key) => {
                      if (key)
                        setRevealMessage((previous) => ({
                          key,
                          request: (previous?.request ?? 0) + 1
                        }))
                    }))
                }
              />
            )}
            <p className="subtitle">
              Ask reads your project. Agent can edit files and request permission to run commands.
            </p>
          </PanelActions>
        </div>
      </div>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {pendingApproval
          ? 'Permission required. Review the command and choose Allow or Deny.'
          : pendingQuestion
            ? 'Agent needs a reply. The question and answer controls follow.'
            : chatError
              ? 'Chat failed. Error details and actions follow.'
              : streaming
                ? 'Agent is working. Stop is available.'
                : 'Chat is ready.'}
      </span>
      {pendingApproval && onApprovalDecision && (
        <div
          ref={approvalRef}
          className="approval-card"
          role="region"
          aria-label="Permission required"
        >
          <div className="approval-title">
            {pendingApproval.kind === 'mcp'
              ? `Agent wants to call MCP tool ${pendingApproval.toolName || ''}`
              : pendingApproval.kind === 'push'
                ? 'Agent wants to push to the remote'
                : 'Agent wants to run a command'}
            {pendingApproval.queuedCount && pendingApproval.queuedCount > 1
              ? ` · ${pendingApproval.queuedCount} approvals waiting`
              : ''}
          </div>
          <pre className="approval-command">{pendingApproval.command}</pre>
          <div className="approval-actions">
            <button
              className="btn btn-primary"
              onClick={() => onApprovalDecision(pendingApproval.approvalId, 'allow')}
            >
              Allow once
            </button>
            {pendingApproval.canAlwaysAllow !== false && (
              <button
                className="btn"
                title="Never ask again for this exact command in this workspace"
                onClick={() => onApprovalDecision(pendingApproval.approvalId, 'always')}
              >
                Always allow
              </button>
            )}
            <button
              className="btn"
              data-initial-focus
              onClick={() => onApprovalDecision(pendingApproval.approvalId, 'deny')}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {!composerReady && !modelsOk && (!modelsKnown || modelsError) && (
        <div className="composer-banner" role="status">
          <span>
            {modelsError
              ? 'Could not check models. Open Models and refresh to retry.'
              : 'Checking installed models…'}
          </span>
          {modelsError && (
            <button className="btn" onClick={onOpenModelsSettings}>
              Open Models
            </button>
          )}
        </div>
      )}
      {modelsKnown && !modelsError && !composerReady && !modelsOk && (
        <div className="composer-banner">
          <span>
            Download a <strong>Local model</strong> or <strong>Composer Lite</strong> in Settings →
            Models to start chatting (Ollama is optional).
          </span>
          <button className="btn btn-primary" onClick={onOpenModelsSettings}>
            Open Models
          </button>
        </div>
      )}
      {!composerReady && modelsOk && (
        <div className="composer-banner composer-banner-soft">
          <span>
            Using your connected API / Ollama models. Optional: download a Local model or Composer
            Lite for offline chat inside Eris.
          </span>
          <button className="btn" onClick={onOpenModelsSettings}>
            Models
          </button>
        </div>
      )}

      {streaming && liveSessionSteps.length > 0 && (
        <div className="composer-banner composer-banner-soft session-steps-banner">
          <span className="session-steps-label">Checkpoints</span>
          <div className="session-steps-list">
            {liveSessionSteps.slice(-8).map((s) => (
              <span key={s.step} className="session-step-chip" title={s.summary}>
                {s.step}
              </span>
            ))}
          </div>
        </div>
      )}

      {memoryNotice && (
        <div className="composer-banner composer-banner-soft memory-banner">
          <span title={memoryNotice.preview}>
            {memoryNotice.kind === 'proposal'
              ? 'Remember this in project memory?'
              : 'Project memory updated'}
            {memoryNotice.preview ? `: ${memoryNotice.preview.slice(0, 100)}` : ''}
          </span>
          {memoryNotice.kind === 'proposal' ? (
            <>
              {onMemoryRemember && (
                <button type="button" className="btn btn-primary" onClick={onMemoryRemember}>
                  Remember
                </button>
              )}
              {onMemoryDismiss && (
                <button type="button" className="btn" onClick={onMemoryDismiss}>
                  Dismiss
                </button>
              )}
            </>
          ) : (
            <>
              {onMemoryUndo && (
                <button type="button" className="btn" onClick={onMemoryUndo}>
                  Undo
                </button>
              )}
              {onMemoryDismiss && (
                <button type="button" className="btn" onClick={onMemoryDismiss}>
                  Dismiss
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="agent-main">
        <div className="agent-messages" data-virtual-scroll>
          {!activeThread && !streaming && !chatError ? (
            <div className="chat-empty agent-welcome">
              <h2>Chat runs one agent</h2>
              <p>
                Auto picks the role from your message. Ask never edits. Pin an agent when you want
                that role every time.
              </p>
              <ul className="agent-roster">
                {CHAT_AGENT_CONTRACTS.map((agent) => (
                  <li key={agent.id}>
                    <strong>
                      {agent.name}
                      {agent.auto ? '' : ' · pin'}
                    </strong>
                    <span>{agent.job}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="chat-messages">
              {!!(history?.start ?? activeThread?.messageOffset) && onLoadEarlier && (
                <button
                  className="btn"
                  disabled={loadingHistory}
                  onClick={() => loadHistory(onLoadEarlier)}
                >
                  {loadingHistory ? 'Loading…' : 'Load earlier messages'}
                </button>
              )}
              {historyError && <div role="alert">{historyError}</div>}
              <ChatTaskTimeline threadId={activeThread?.id ?? null} />
              <HistoricalMessages
                key={activeThread?.id ?? 'empty'}
                searchOpen={searchOpen}
                onCloseSearch={closeSearch}
                revealMessage={revealMessage}
                messages={history?.messages ?? activeThread?.messages ?? EMPTY_MESSAGES}
                onOpenPath={onOpenPath}
                onRerouteLast={onRerouteLast}
                streaming={streaming}
              />
              {history?.gap && onLoadNewer && (
                <div className="chat-history-gap">
                  <button
                    className="btn"
                    disabled={loadingHistory}
                    onClick={() => loadHistory(onLoadNewer)}
                  >
                    {loadingHistory ? 'Loading…' : 'Load newer messages'}
                  </button>
                  <button className="btn" onClick={onJumpToLatest}>
                    Jump to latest
                  </button>
                </div>
              )}
              {streaming && (
                <div className="msg assistant">
                  <span className="role">
                    assistant
                    {routeLabel ? ` · ${routeLabel}` : ''}
                    {chatMode === 'ask' ? ' · Ask' : ' · Agent'}
                  </span>
                  <ThinkingBlock
                    thinking={thinkingBuffer}
                    status={answerBuffer ? null : agentStatus}
                    tools={toolActivity}
                    defaultOpen={false}
                    live={!answerBuffer}
                  />
                  <DelegationCards items={delegations} />
                  {pendingQuestion && onQuestionReply && (
                    <InlineAgentQuestion
                      key={pendingQuestion.questionId}
                      question={pendingQuestion}
                      onReply={(reply) => onQuestionReply(pendingQuestion.questionId, reply)}
                    />
                  )}
                  {answerBuffer ? (
                    <div className="msg-summary">
                      <MarkdownMessage content={answerBuffer} onOpenPath={onOpenPath} plain />
                    </div>
                  ) : (
                    !thinkingBuffer && (
                      <div className="answer-placeholder">
                        {chatMode === 'ask' ? 'Thinking…' : 'Working in the workspace…'}
                      </div>
                    )
                  )}
                </div>
              )}
              {chatError && !streaming && (
                <div className="msg error" role="alert">
                  <span className="role">error</span>
                  {chatError}
                  <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                    {(!composerReady || !modelsOk) && (
                      <button className="btn btn-primary" onClick={onOpenModelsSettings}>
                        Open Models settings
                      </button>
                    )}
                    <button className="btn" onClick={onDismissError}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div
          className={`chat-composer agent-composer ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const paths = Array.from(e.dataTransfer.files)
              .map((f) => window.ide.getPathForFile(f))
              .filter(Boolean)
            if (paths.length === 0) return
            const next = [...attachments]
            for (const path of paths) {
              if (next.some((a) => a.path === path)) continue
              next.push({ path, name: pathBasename(path) })
            }
            onAttachmentsChange(next)
          }}
        >
          <div className="composer-wrap">
            {queuedMessages.length > 0 && (
              <div className="message-queue" aria-label="Queued messages">
                <div className="message-queue-head">
                  <strong>Queued</strong>
                  <span className="subtitle" style={{ margin: 0 }}>
                    {queuedMessages.length}/{MAX_QUEUED_MESSAGES}
                    {streaming ? ' · sends when current reply finishes' : ''}
                  </span>
                </div>
                {queuedMessages.map((q, i) => (
                  <div key={q.id} className="message-queue-item">
                    <span className="message-queue-index">{i + 1}</span>
                    <span className="message-queue-text" title={q.text}>
                      {q.text}
                      {q.attachments.length > 0
                        ? ` · ${q.attachments.length} file${q.attachments.length === 1 ? '' : 's'}`
                        : ''}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      title="Remove from queue"
                      onClick={() => onRemoveQueued(q.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {slashItems.length > 0 && (
              <div className="slash-menu" role="listbox">
                {slashItems.map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`slash-item ${i === slashIndex ? 'active' : ''}`}
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => applySlashItem(item)}
                  >
                    <span className="slash-item-cmd">{item.command}</span>
                    <span className="slash-item-meta">
                      <strong>{item.label}</strong>
                      <span>{item.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {atItems.length > 0 && (
              <div className="slash-menu at-menu" role="listbox">
                {atItems.map((item, i) => (
                  <button
                    key={item.path}
                    type="button"
                    className={`slash-item ${i === atIndex ? 'active' : ''}`}
                    onMouseEnter={() => setAtIndex(i)}
                    onClick={() => applyAtItem(item)}
                  >
                    <span className="slash-item-cmd">@{item.name}</span>
                    <span className="slash-item-meta">
                      <strong>{item.path}</strong>
                      <span>Add as context</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="composer-bar">
              <textarea
                ref={textareaRef}
                data-chat-composer
                aria-label="Chat message"
                value={draft}
                lang="en"
                spellCheck
                autoCorrect="on"
                autoCapitalize="sentences"
                placeholder={
                  streaming
                    ? queueFull
                      ? 'Queue full (3) — wait for a reply to finish…'
                      : 'Queue next message (up to 3)…'
                    : chatMode === 'ask'
                      ? 'Ask a question… @ for files, / for skills'
                      : 'Message the agent… @ for files, / for skills'
                }
                onChange={(e) => {
                  setDraft(e.target.value)
                  setCaret(e.target.selectionStart)
                }}
                onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onKeyDown={(e) => {
                  if (atItems.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setAtIndex((i) => Math.min(i + 1, atItems.length - 1))
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setAtIndex((i) => Math.max(i - 1, 0))
                      return
                    }
                    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                      e.preventDefault()
                      applyAtItem(atItems[atIndex] ?? atItems[0]!)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setCaret(0)
                      return
                    }
                  }
                  if (slashItems.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setSlashIndex((i) => Math.min(i + 1, slashItems.length - 1))
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSlashIndex((i) => Math.max(i - 1, 0))
                      return
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      applySlashItem(slashItems[slashIndex] ?? slashItems[0])
                      return
                    }
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      applySlashItem(slashItems[slashIndex] ?? slashItems[0])
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setDraft('')
                      return
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
              {(attachments.length > 0 || activeSkills.length > 0) && (
                <div className="attachment-chips">
                  {activeSkills.map((s) => (
                    <span
                      key={s.id}
                      className="attachment-chip skill-chip"
                      title={`Skill: ${s.name}`}
                    >
                      <span className="attachment-name">/{s.id}</span>
                      <button
                        className="btn-ghost"
                        onClick={() =>
                          onActiveSkillsChange(activeSkills.filter((x) => x.id !== s.id))
                        }
                        title="Remove skill"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {attachments.map((a) => (
                    <span key={a.path} className="attachment-chip" title={a.path}>
                      <span className="attachment-name">{a.name}</span>
                      <button
                        className="btn-ghost"
                        onClick={() => removeAttachment(a.path)}
                        title="Remove"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="composer-controls">
                <div className="composer-attach" ref={attachMenuRef}>
                  <button
                    type="button"
                    className="composer-attach-btn"
                    title="Add attachment"
                    aria-label="Add attachment"
                    onClick={() => {
                      if (openTabs.length > 0) setAttachMenuOpen((v) => !v)
                      else onImportFiles()
                    }}
                  >
                    +
                  </button>
                  {attachMenuOpen && (
                    <div className="composer-attach-menu">
                      <button
                        type="button"
                        onClick={() => {
                          setAttachMenuOpen(false)
                          onImportFiles()
                        }}
                      >
                        Browse files…
                      </button>
                      {openTabs.map((t) => (
                        <button
                          key={t.path}
                          type="button"
                          disabled={attachments.some((a) => a.path === t.path)}
                          onClick={() => {
                            setAttachMenuOpen(false)
                            onAttachOpenTab(t.path)
                          }}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="composer-right">
                  <select
                    className="composer-model-select"
                    value={selectValue}
                    disabled={streaming}
                    onChange={(e) => onModelChange(e.target.value)}
                    title={`${modelDataHint(modelOptions.find((m) => m.name === selectValue) || modelOptions[0]!)} Auto chooses a model for the turn; a picked model is used as-is.`}
                    aria-label="Select model"
                  >
                    {modelOptions.map((m) => (
                      <option key={m.name} value={m.name} title={modelDataHint(m)}>
                        {modelLabel(m)}
                      </option>
                    ))}
                  </select>
                  {streaming ? (
                    <>
                      <button
                        className="btn btn-primary composer-send-btn"
                        onClick={submit}
                        disabled={!canCompose || queueFull}
                        title={
                          queueFull
                            ? 'Queue is full (max 3)'
                            : 'Queue this message for after the current reply'
                        }
                      >
                        Queue
                      </button>
                      <button className="btn composer-send-btn" onClick={onStop}>
                        Stop
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-primary composer-send-btn"
                      onClick={submit}
                      disabled={!canCompose}
                    >
                      Send
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
