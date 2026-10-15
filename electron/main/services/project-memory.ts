import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../../../src/shared/settings-schema'
import {
  appendContextNote,
  CONTEXT_PIN_MAX,
  getWorkspaceContext,
  saveWorkspaceContext,
  setContextSummary
} from './workspace-context'
import { workspaceConfigDir } from './paths'

export type ProjectMemoryMode = 'auto' | 'ask' | 'off'

export type MemoryWriteKind = 'note' | 'summary' | 'ask_user'

export type MemoryWriteResult = {
  wrote: boolean
  kind?: MemoryWriteKind
  preview: string
  /** When mode is ask — UI should confirm before writing */
  needsConfirm?: boolean
  note?: string
  summary?: string
}

export type AgentRunMemoryInput = {
  goal: string
  filesTouched: string[]
  actionLog: string[]
  answerSnippet?: string
  incomplete?: boolean
  aborted?: boolean
}

const MAX_NOTE = 360
const MAX_ACTIONS = 6
const MAX_FILES = 8

function undoPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'context.prev.md')
}

export function projectMemoryMode(settings: AppSettings | undefined): ProjectMemoryMode {
  const mode = settings?.agent?.projectMemory
  if (mode === 'ask' || mode === 'off' || mode === 'auto') return mode
  return 'auto'
}

/** Snapshot current context.md so the last auto memory write can be undone. */
export function snapshotContextForUndo(workspacePath: string): void {
  const doc = getWorkspaceContext(workspacePath)
  writeFileSync(undoPath(workspacePath), doc.body || '', 'utf8')
}

export function canUndoProjectMemory(workspacePath: string | null): boolean {
  if (!workspacePath) return false
  return existsSync(undoPath(workspacePath))
}

export function undoLastProjectMemory(workspacePath: string): {
  ok: boolean
  body: string
  pin: string
  updatedAt: number
  empty: boolean
} {
  const path = undoPath(workspacePath)
  if (!existsSync(path)) {
    const cur = getWorkspaceContext(workspacePath)
    return { ok: false, ...cur }
  }
  const prev = readFileSync(path, 'utf8')
  const doc = saveWorkspaceContext(workspacePath, prev)
  try {
    writeFileSync(path, '', 'utf8')
  } catch {
    /* ignore */
  }
  return { ok: true, ...doc }
}

function cleanGoal(goal: string): string {
  return goal.replace(/\s+/g, ' ').trim().slice(0, 140)
}

function redactSecrets(text: string): string {
  return text
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*\S+/gi,
      '$1=(redacted)'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer (redacted)')
}

function buildRunNote(input: AgentRunMemoryInput): string | null {
  if (input.aborted) return null
  const goal = cleanGoal(input.goal)
  const files = [...new Set(input.filesTouched)]
    .filter(Boolean)
    .slice(0, MAX_FILES)
  const actions = [...new Set(input.actionLog)]
    .filter(Boolean)
    .slice(-MAX_ACTIONS)
  const hasSignal = files.length > 0 || actions.length > 0
  if (!hasSignal && !input.answerSnippet?.trim()) return null

  const bits: string[] = []
  if (goal) bits.push(goal)
  if (files.length) bits.push(`files: ${files.join(', ')}`)
  if (actions.length) {
    bits.push(
      `did: ${actions
        .map((a) => a.replace(/\s+/g, ' ').trim().slice(0, 60))
        .join('; ')}`
    )
  } else if (input.answerSnippet?.trim()) {
    bits.push(input.answerSnippet.replace(/\s+/g, ' ').trim().slice(0, 120))
  }
  if (input.incomplete) bits.push('(incomplete)')

  const note = redactSecrets(bits.join(' — ')).slice(0, MAX_NOTE)
  if (note.length < 12) return null
  return note
}

function buildAskUserNote(question: string, reply: string): string {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 120)
  const a = reply.replace(/\s+/g, ' ').trim().slice(0, 160)
  return redactSecrets(`User choice: ${a}${q ? ` (re: ${q})` : ''}`).slice(0, MAX_NOTE)
}

/** Bootstrap a short Summary when the pin is empty and we learned something. */
function maybeBootstrapSummary(
  workspacePath: string,
  input: AgentRunMemoryInput
): string | null {
  const pin = getWorkspaceContext(workspacePath).pin.trim()
  if (pin) return null
  const files = [...new Set(input.filesTouched)].filter(Boolean).slice(0, 5)
  if (!files.length && !input.actionLog.length) return null
  const goal = cleanGoal(input.goal)
  const lines = [
    goal ? `Focus: ${goal}` : '',
    files.length ? `Recent paths: ${files.join(', ')}` : '',
    'Auto-filled by Eris project memory — edit freely.'
  ].filter(Boolean)
  const summary = lines.join('\n').slice(0, CONTEXT_PIN_MAX)
  return summary.length >= 20 ? summary : null
}

function applyNote(workspacePath: string, note: string): MemoryWriteResult {
  snapshotContextForUndo(workspacePath)
  appendContextNote(workspacePath, note)
  return { wrote: true, kind: 'note', preview: note.slice(0, 160) }
}

function applySummary(workspacePath: string, summary: string): MemoryWriteResult {
  snapshotContextForUndo(workspacePath)
  setContextSummary(workspacePath, summary)
  return { wrote: true, kind: 'summary', preview: summary.slice(0, 160) }
}

/**
 * Persist durable memory after an agent run (or return a proposal in ask mode).
 */
export function rememberAgentRun(
  workspacePath: string | null,
  settings: AppSettings | undefined,
  input: AgentRunMemoryInput
): MemoryWriteResult {
  const mode = projectMemoryMode(settings)
  if (mode === 'off' || !workspacePath) {
    return { wrote: false, preview: '' }
  }
  if (input.aborted) return { wrote: false, preview: '' }

  const note = buildRunNote(input)
  const summary = maybeBootstrapSummary(workspacePath, input)
  if (!note && !summary) return { wrote: false, preview: '' }

  if (mode === 'ask') {
    return {
      wrote: false,
      needsConfirm: true,
      note: note || undefined,
      summary: summary || undefined,
      preview: (note || summary || '').slice(0, 160)
    }
  }

  // Prefer keeping a useful Summary empty-fill, then always append the note.
  let result: MemoryWriteResult = { wrote: false, preview: '' }
  if (summary) result = applySummary(workspacePath, summary)
  if (note) {
    // If we already snapshotted for summary, appendNote still mutates — one undo restores pre-run.
    if (!result.wrote) snapshotContextForUndo(workspacePath)
    appendContextNote(workspacePath, note)
    result = {
      wrote: true,
      kind: result.wrote ? 'summary' : 'note',
      preview: note.slice(0, 160)
    }
  }
  return result
}

export function rememberAskUserReply(
  workspacePath: string | null,
  settings: AppSettings | undefined,
  question: string,
  reply: string
): MemoryWriteResult {
  const mode = projectMemoryMode(settings)
  if (mode === 'off' || !workspacePath || !reply.trim()) {
    return { wrote: false, preview: '' }
  }
  const note = buildAskUserNote(question, reply)
  if (mode === 'ask') {
    return { wrote: false, needsConfirm: true, note, preview: note.slice(0, 160) }
  }
  return applyNote(workspacePath, note)
}

/** Confirm a pending ask-mode proposal. */
export function confirmProjectMemory(
  workspacePath: string,
  proposal: { note?: string; summary?: string }
): MemoryWriteResult {
  let result: MemoryWriteResult = { wrote: false, preview: '' }
  if (proposal.summary?.trim()) {
    result = applySummary(workspacePath, proposal.summary.trim())
  }
  if (proposal.note?.trim()) {
    if (!result.wrote) snapshotContextForUndo(workspacePath)
    appendContextNote(workspacePath, proposal.note.trim())
    result = {
      wrote: true,
      kind: result.kind || 'note',
      preview: proposal.note.trim().slice(0, 160)
    }
  }
  return result
}
