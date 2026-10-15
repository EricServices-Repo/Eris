import { parseToolCalls, stripToolBlocks } from './tool-parsing'
import type { ToolCall } from './types'

export function looksLikeRefusal(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (!t) return false
  if (parseToolCalls(text).length > 0) return false
  return (
    /\bi('m| am) sorry\b/.test(t) ||
    /\bi can'?t assist\b/.test(t) ||
    /\bi cannot assist\b/.test(t) ||
    /\bi'?m not able to (help|assist)\b/.test(t) ||
    /\bas an ai\b/.test(t) ||
    /\bi must refuse\b/.test(t)
  )
}

/** Detect stuck repetitive generation (common on small local models). */
export function looksLikeDegenerateLoop(text: string): boolean {
  if (text.length < 280) return false
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length >= 10) {
    const normalized = lines.map((l) => l.replace(/^\d+\.\s*/, '').slice(0, 72).toLowerCase())
    const last = normalized.slice(-10)
    const unique = new Set(last)
    if (unique.size <= 3) return true
    const counts = new Map<string, number>()
    for (const l of normalized) counts.set(l, (counts.get(l) || 0) + 1)
    if ([...counts.values()].some((n) => n >= 5)) return true
  }
  const tail = text.slice(-160)
  if (tail.length >= 80) {
    const occurrences = text.split(tail).length - 1
    if (occurrences >= 3) return true
  }
  // Same 48-char window thrashing
  if (text.length > 500) {
    const win = text.slice(-48)
    let hits = 0
    for (let i = 0; i < text.length - 48; i += 24) {
      if (text.slice(i, i + 48) === win) hits++
      if (hits >= 4) return true
    }
  }
  return false
}

export function talksAboutToolsWithoutCalling(text: string): boolean {
  if (parseToolCalls(text).length > 0) return false
  const t = text.toLowerCase()
  const mentions =
    /\b(list_dir|read_file|write_file|mkdir|delete_path|rename_path|<<<tool>>>)\b/i.test(t) ||
    /"name"\s*:\s*"(tree|list_dir|read_file|write_file)"/i.test(t) ||
    /\bi will (use|call|run) (the )?(tool|list_dir|read_file|tree)\b/i.test(t)
  const longPlan = (text.match(/^\s*\d+\.\s+/gm) || []).length >= 5
  return mentions || longPlan
}

/**
 * Model is asking the user for workspace facts it should discover with tools
 * (tree / list_dir / retrieve / read_file) — never pause or finish on these.
 */
export function looksLikeAsksForWorkspaceInfo(text: string): boolean {
  const t = stripToolBlocks(text).trim().toLowerCase()
  if (!t) return false
  if (parseToolCalls(text).length > 0) return false
  return (
    /\b(provide|share|send|paste|give me|upload)\b[\s\S]{0,40}\b(structure|folder|directory|tree|files?|code|project|repo|workspace|sources?)\b/i.test(
      t
    ) ||
    /\b(project|folder|directory|repo|workspace)\s+(structure|layout|tree)\b/i.test(t) ||
    /\b(which files|what files|list (the )?files|show me (the )?(files|structure|tree))\b/i.test(
      t
    ) ||
    /\bcould you please provide\b[\s\S]{0,80}\b(structure|files?|folder)\b/i.test(t)
  )
}

/** Model claims the job is finished (no more tools needed). */
export function looksLikeTaskComplete(text: string): boolean {
  const t = text.trim()
  if (!t || parseToolCalls(t).length > 0) return false
  if (looksLikeRefusal(t) || looksLikeDegenerateLoop(t) || talksAboutToolsWithoutCalling(t)) {
    return false
  }
  if (looksLikeAsksForWorkspaceInfo(t)) return false
  // Questions are not a finished review/edit.
  if (/\?\s*$/.test(t) || (t.match(/\?/g) || []).length >= 2) return false
  const lower = t.toLowerCase()
  if (
    /\b(next i (will|shall)|still need|not (yet )?done|todo\b|remaining|i('ll| will) (now|next)|let me (now )?)\b/i.test(
      lower
    )
  ) {
    return false
  }
  if ((t.match(/^\s*\d+\.\s+/gm) || []).length >= 3) return false
  // Require an actual completion signal — short prose alone used to match and
  // let review runs stop on "please provide the project structure?"
  return /\b(done|complete|completed|finished|created|updated|ready|all set|implemented|here'?s what|working|findings|reviewed|looks good|issues?:)\b/i.test(
    lower
  )
}

/**
 * True when the model is asking the user to choose before continuing
 * (not a rhetorical DONE summary that happens to end with "?").
 */
export function looksLikeClarifyingQuestion(text: string): boolean {
  const t = stripToolBlocks(text).trim()
  if (t.length < 24 || t.length > 1400) return false
  if (parseToolCalls(text).length > 0) return false
  // Never treat "please paste the repo tree" as an inline user question.
  if (looksLikeAsksForWorkspaceInfo(t)) return false
  // Already sounds finished — don't hijack.
  if (
    /\b(done|finished|complete|here's what|here is what|summary:)\b/i.test(t) &&
    !/\?\s*$/.test(t)
  ) {
    return false
  }
  const askVerb =
    /\b(should I|do you want|would you like|which (one|option|approach)|prefer|please (choose|confirm|reply|let me know)|can you (confirm|clarify)|before I (continue|proceed|start))\b/i.test(
      t
    )
  const endsQuestion = /\?\s*$/.test(t)
  const numberedChoice = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+\S+/m.test(t) && endsQuestion
  return (endsQuestion && askVerb) || numberedChoice
}

/** Review/confirm goals should finish without write_file. */
export function isReviewOnlyGoal(text: string): boolean {
  const t = text.toLowerCase()
  const review =
    /\b(review|confirm|check if|verify|inspect|look over|is it working|does it work|working calculator|status)\b/i.test(
      t
    )
  const edit =
    /\b(create|implement|fix|add |build|scaffold|write|refactor|delete|rename|update the|make a|improv(e|ements?)|polish|enhance)\b/i.test(
      t
    )
  return review && !edit
}

/**
 * Skill / rules / context edits live under `.eris/` and must not trigger
 * project typecheck/test verify (that hangs skill creation on "Final verify…").
 */
export function pathNeedsProjectVerify(path: string | undefined | null): boolean {
  if (!path) return false
  const norm = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (norm === '.eris' || norm.startsWith('.eris/')) return false
  // Bare skill markdown drops outside .eris are still meta
  if (/(^|\/)SKILL\.md$/i.test(norm)) return false
  return true
}

/** Workspace task still needs tool work — keep the loop alive. */
export function shouldKeepWorking(opts: {
  needsTools: boolean
  mutated: boolean
  assistantText: string
  reviewOnly?: boolean
  inspectRounds?: number
  actions?: string[]
}): boolean {
  const { needsTools, mutated, assistantText, reviewOnly, inspectRounds = 0, actions = [] } =
    opts
  if (!needsTools) return false
  if (!assistantText.trim()) return true
  if (looksLikeRefusal(assistantText)) return true
  if (looksLikeAsksForWorkspaceInfo(assistantText)) return true
  if (talksAboutToolsWithoutCalling(assistantText)) return true
  if (looksLikeDegenerateLoop(assistantText)) return true

  // Review-only: allow DONE after some inspection / verify without file mutations
  if (reviewOnly && looksLikeTaskComplete(assistantText)) {
    if (inspectRounds >= 1 || actions.some((a) => /read|verify|run|inspect/i.test(a))) {
      return false
    }
  }

  if (!mutated) {
    // Edit goals must mutate; review goals can stop once they sound complete after inspect
    if (reviewOnly && inspectRounds >= 3 && looksLikeTaskComplete(assistantText)) return false
    if (!reviewOnly) return true
  }
  if (!looksLikeTaskComplete(assistantText)) return true
  return false
}

export function toolFingerprint(calls: ToolCall[]): string {
  return calls
    .map((c) => {
      const path = typeof c.args.path === 'string' ? c.args.path : ''
      const to = typeof c.args.to === 'string' ? c.args.to : ''
      const contentLen =
        typeof c.args.content === 'string' ? String(c.args.content.length) : ''
      return `${c.name}:${path}:${to}:${contentLen}`
    })
    .join('|')
}
