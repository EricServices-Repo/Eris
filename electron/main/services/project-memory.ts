import { homedir } from 'os'
import { redactBugReportText } from '../../../src/shared/bug-report-sanitize'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings, ChatIntent } from '../../../src/shared/settings-schema'
import {
  appendContextNote,
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
  intent?: ChatIntent
  goal: string
  filesTouched: string[]
  actionLog: string[]
  answerSnippet?: string
  incomplete?: boolean
  aborted?: boolean
}

const MAX_NOTE = 360
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

/**
 * Notes and the bootstrapped Summary land in .eris/context.md, which is often committed.
 * Use the shared redactor: a local copy here missed `Authorization: Bearer <token>`
 * (only "Bearer" was redacted) and bare provider keys such as sk-proj-… or hf_….
 */
function redactSecrets(text: string): string {
  return redactBugReportText(text, homedir())
}

function buildRunNote(input: AgentRunMemoryInput): string | null {
  if (input.aborted || (input.intent && ['answer', 'capability', 'explore', 'review', 'plan'].includes(input.intent))) return null
  const files = [...new Set(input.filesTouched)].filter(path => {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
    return normalized && !normalized.startsWith('.eris/') && !normalized.startsWith('.ericservices-ide/')
  }).slice(0, MAX_FILES)
  if (!files.length) return null
  const goal = input.incomplete ? '' : cleanGoal(input.goal).slice(0, 80)
  return redactSecrets(`run: changed${input.incomplete ? ' (incomplete run)' : ''} ${files.join(', ')}${goal ? ` — ${goal}` : ''}`).slice(0, MAX_NOTE)
}

function buildAskUserNote(question: string, reply: string): string {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 120)
  const a = reply.replace(/\s+/g, ' ').trim().slice(0, 160)
  return redactSecrets(`User choice: ${a}${q ? ` (re: ${q})` : ''}`).slice(0, MAX_NOTE)
}

/** Prune only machine-generated run bullets inside Notes; preserve all other text. */
function appendRunNote(workspacePath: string, note: string): void {
  const body = appendContextNote(workspacePath, note).body
  const next = body.replace(/(^##\s+Notes\s*\n)([\s\S]*?)(?=^##\s+|(?![\s\S]))/im, (_match, heading: string, section: string) => {
    let seen = 0
    const lines = section.split('\n').filter(line => {
      if (!/^- \(\d{4}-\d{2}-\d{2}\) run: changed(?: \(incomplete run\))? /u.test(line)) return true
      return ++seen <= 20
    })
    return heading + lines.join('\n')
  })
  if (next !== body) saveWorkspaceContext(workspacePath, next)
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
  if (!note) return { wrote: false, preview: '' }
  const preview = note.replace(/^run: /, '').split(' — ')[0] || ''

  if (mode === 'ask') {
    return {
      wrote: false,
      needsConfirm: true,
      note,
      preview: preview.slice(0, 160)
    }
  }

  snapshotContextForUndo(workspacePath)
  appendRunNote(workspacePath, note)
  return { wrote: true, kind: 'note', preview: preview.slice(0, 160) }
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
    if (proposal.note.trim().startsWith('run: changed')) appendRunNote(workspacePath, proposal.note.trim())
    else appendContextNote(workspacePath, proposal.note.trim())
    result = {
      wrote: true,
      kind: result.kind || 'note',
      preview: proposal.note.trim().startsWith('run: changed')
        ? proposal.note.trim().replace(/^run: /, '').split(' — ')[0]!.slice(0, 160)
        : proposal.note.trim().slice(0, 160)
    }
  }
  return result
}
