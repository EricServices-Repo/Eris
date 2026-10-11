import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatThread, ModelInfo, SkillRecord } from '@/shared/settings-schema'
import { ThinkingBlock, type ToolActivityItem } from './ThinkingBlock'
import { MarkdownMessage } from './MarkdownMessage'

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

interface SlashItem {
  id: string
  command: string
  label: string
  hint: string
  kind: 'action' | 'skill'
  skillId?: string
}

interface Props {
  activeThread: ChatThread | null
  routeLabel: string | null
  composerReady: boolean
  /** True when any chat backend is ready (builtin or Ollama/API connection). */
  modelsOk?: boolean
  streaming: boolean
  thinkingBuffer: string
  answerBuffer: string
  chatError: string | null
  agentStatus: string | null
  toolActivity: ToolActivityItem[]
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
  /** Hand current/last goal to a background worktree agent */
  onRunInBackground?: (goal?: string) => void
  backgroundBusy?: boolean
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
  /** Re-run the last user message with a forced route */
  onRerouteLast?: (intent: 'tools' | 'answer') => void
  resumableRun?: { goal: string; updatedAt: string; step: number } | null
  onResumeRun?: () => void
  onDismissResume?: () => void
}

export interface PendingCommandApproval {
  approvalId: string
  kind: 'run' | 'push'
  command: string
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

export function ChatPanel({
  activeThread,
  routeLabel,
  composerReady,
  modelsOk = false,
  streaming,
  thinkingBuffer,
  answerBuffer,
  chatError,
  agentStatus,
  toolActivity,
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
  onRunInBackground,
  backgroundBusy = false,
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
  onRerouteLast,
  resumableRun = null,
  onResumeRun,
  onDismissResume
}: Props) {
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [atIndex, setAtIndex] = useState(0)
  const [caret, setCaret] = useState(0)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!attachMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!attachMenuRef.current?.contains(e.target as Node)) setAttachMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [attachMenuOpen])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeThread?.messages, thinkingBuffer, answerBuffer, routeLabel, chatError, toolActivity])

  const slashQuery = parseSlashQuery(draft)
  const atQuery = parseAtQuery(draft, caret)

  const atItems = useMemo(() => {
    if (!atQuery) return []
    const pool = [
      ...openTabs.map((t) => ({ path: t.path, name: t.name })),
      ...mentionFiles
    ]
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

  const canCompose =
    Boolean(draft.trim()) || attachments.length > 0 || activeSkills.length > 0
  const queueFull = queuedMessages.length >= MAX_QUEUED_MESSAGES

  const modelOptions = useMemo(() => {
    if (models.length > 0) return models
    return [
      {
        name: selectedModel || 'builtin:composer-lite',
        ready: composerReady,
        source: 'builtin' as const
      }
    ]
  }, [models, selectedModel, composerReady])

  const modelLabel = (m: ModelInfo): string => {
    const base = m.source === 'builtin' ? m.name.replace(/^builtin:/, '') : m.name
    return `${base}${m.ready === false ? ' (offline)' : ''}`
  }

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
    <div className="agent-center">
      <div className="panel-header agent-header">
        <span>{activeThread?.title || 'Agent'}</span>
        <div className="mode-toggle" role="group" aria-label="Chat mode">
          <button
            type="button"
            className={`mode-btn ${chatMode === 'ask' ? 'active' : ''}`}
            onClick={() => onChatModeChange('ask')}
            title="Answer only — no file edits"
          >
            Ask
          </button>
          <button
            type="button"
            className={`mode-btn ${chatMode === 'agent' ? 'active' : ''}`}
            onClick={() => onChatModeChange('agent')}
            title="Agent can edit the workspace"
          >
            Agent
          </button>
        </div>
        <button className="btn" onClick={onNewChat} title="New chat">
          New chat
        </button>
      </div>

      {!composerReady && !modelsOk && (
        <div className="composer-banner">
          <span>
            Connect <strong>Ollama</strong> or download <strong>Composer Lite</strong> (~1 GB) in
            Settings → Models to start chatting.
          </span>
          <button className="btn btn-primary" onClick={onOpenModelsSettings}>
            Open Models
          </button>
        </div>
      )}
      {!composerReady && modelsOk && (
        <div className="composer-banner composer-banner-soft">
          <span>
            Using your connected API / Ollama models. Optional: download Composer Lite for offline
            built-in chat.
          </span>
          <button className="btn" onClick={onOpenModelsSettings}>
            Models
          </button>
        </div>
      )}

      {resumableRun && !streaming && onResumeRun && (
        <div className="composer-banner composer-banner-soft">
          <span>
            Last agent task stopped after {resumableRun.step} step
            {resumableRun.step === 1 ? '' : 's'}: <strong>{resumableRun.goal.slice(0, 120)}</strong>
          </span>
          <button className="btn btn-primary" onClick={onResumeRun}>
            Resume last task
          </button>
          {onDismissResume && (
            <button className="btn" onClick={onDismissResume}>
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="agent-main">
        <div className="agent-messages">
          {!activeThread && !streaming && !chatError ? (
            <div className="chat-empty agent-welcome">
              <h2>Talk to your agent</h2>
              <p>
                Open <strong>Chats</strong> under your project in the Explorer, or start a new one.
                Type <code>/</code> for skills, <code>@</code> for files. Switch Ask / Agent above.
              </p>
            </div>
          ) : (
            <div className="chat-messages">
              {activeThread?.messages
                .filter((m) => m.role !== 'system')
                .map((m, i, visible) => (
                  <div key={m.id} className={`msg ${m.role}`}>
                    <span className="role">
                      {m.role}
                      {m.agentName ? ` · ${m.agentName}` : ''}
                      {m.model ? ` · ${m.model}` : ''}
                    </span>
                    {m.role === 'assistant' && m.thinking && (
                      <ThinkingBlock thinking={m.thinking} defaultOpen={false} />
                    )}
                    {m.role === 'assistant' ? (
                      <MarkdownMessage content={m.content} onOpenPath={onOpenPath} />
                    ) : (
                      <div className="user-text">{m.content}</div>
                    )}
                    {m.role === 'assistant' &&
                      i === visible.length - 1 &&
                      !streaming &&
                      onRerouteLast && (
                        <div className="msg-reroute">
                          <span>Wrong route?</span>
                          <button
                            type="button"
                            className="btn btn-link"
                            title="Re-run this message with workspace tools"
                            onClick={() => onRerouteLast('tools')}
                          >
                            Needed tools
                          </button>
                          <button
                            type="button"
                            className="btn btn-link"
                            title="Re-run this message as a plain answer"
                            onClick={() => onRerouteLast('answer')}
                          >
                            Just a question
                          </button>
                          {onRunInBackground && (
                            <button
                              type="button"
                              className="btn btn-link"
                              title="Continue this goal on a private git worktree"
                              disabled={backgroundBusy}
                              onClick={() => onRunInBackground()}
                            >
                              Run in background
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                ))}
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
                    defaultOpen={!answerBuffer}
                    live={!answerBuffer}
                  />
                  {pendingApproval && onApprovalDecision && (
                    <div className="approval-card" role="alertdialog">
                      <div className="approval-title">
                        {pendingApproval.kind === 'push'
                          ? 'Agent wants to push to the remote'
                          : 'Agent wants to run a command'}
                      </div>
                      <pre className="approval-command">{pendingApproval.command}</pre>
                      <div className="approval-actions">
                        <button
                          className="btn btn-primary"
                          onClick={() => onApprovalDecision(pendingApproval.approvalId, 'allow')}
                        >
                          Allow
                        </button>
                        <button
                          className="btn"
                          title="Never ask again for this exact command in this workspace"
                          onClick={() => onApprovalDecision(pendingApproval.approvalId, 'always')}
                        >
                          Always allow
                        </button>
                        <button
                          className="btn"
                          onClick={() => onApprovalDecision(pendingApproval.approvalId, 'deny')}
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  )}
                  {answerBuffer ? (
                    <div className="answer-text">
                      <MarkdownMessage content={answerBuffer} onOpenPath={onOpenPath} />
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
                <div className="msg error">
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
              next.push({ path, name: path.split('/').pop() || path })
            }
            onAttachmentsChange(next)
          }}
        >
            {(attachments.length > 0 || activeSkills.length > 0) && (
              <div className="attachment-chips">
                {activeSkills.map((s) => (
                  <span key={s.id} className="attachment-chip skill-chip" title={`Skill: ${s.name}`}>
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
                <textarea
                  ref={textareaRef}
                  value={draft}
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
                <div className="composer-right">
                  <select
                    className="composer-model-select"
                    value={selectedModel || 'builtin:composer-lite'}
                    disabled={streaming}
                    onChange={(e) => onModelChange(e.target.value)}
                    title="Model for this chat"
                    aria-label="Select model"
                  >
                    {modelOptions.map((m) => (
                      <option key={m.name} value={m.name}>
                        {modelLabel(m)}
                      </option>
                    ))}
                  </select>
                  {onRunInBackground && (
                    <button
                      type="button"
                      className="btn composer-send-btn"
                      disabled={backgroundBusy || (!draft.trim() && !activeThread)}
                      title="Run this goal on a private git worktree (Agents inbox)"
                      onClick={() => onRunInBackground(draft.trim() || undefined)}
                    >
                      Background
                    </button>
                  )}
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
  )
}
