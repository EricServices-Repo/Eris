import { createHash } from 'crypto'
import {
  asksForRecommendations,
  asksWhatTheProjectDoes
} from '../../../../src/shared/agent-contract'
import { parseToolCalls, stripToolBlocks } from './tool-parsing'
import type { ToolCall } from './types'

/** A project description has to come from source, not .eris config, and say more than “done”. */
export function projectDescriptionReady(assistantText: string, actions: string[]): boolean {
  if (parseToolCalls(assistantText).length > 0) return false
  const note = stripToolBlocks(assistantText).trim()
  if (note.length < 160) return false
  const readSource = actions.some((action) => /^Read (?!\.eris\/)/.test(action))
  return readSource
}

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
/** Lines that say something. Code, rules and field labels recur in any structured reply. */
function proseLines(text: string): string[] {
  let fenced = false
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (/^(```|~~~)/.test(line)) {
        fenced = !fenced
        return false
      }
      return (
        !fenced &&
        Boolean(line) &&
        !/^([-*_=|]\s*){3,}$/.test(line) &&
        !/^[-*#>\s]*(\*\*[^*]{1,40}\*\*|[\w ]{1,24}:\s)/.test(line)
      )
    })
}

export function looksLikeDegenerateLoop(text: string): boolean {
  if (text.length < 280) return false
  const lines = proseLines(text)
  if (lines.length >= 10) {
    const normalized = lines.map((l) =>
      l
        .replace(/^\d+\.\s*/, '')
        .slice(0, 72)
        .toLowerCase()
    )
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

function mentionsTools(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /\b(list_dir|read_file|write_file|mkdir|delete_path|rename_path|<<<tool>>>)\b/i.test(t) ||
    /"name"\s*:\s*"(tree|list_dir|read_file|write_file)"/i.test(t) ||
    /\bi will (use|call|run) (the )?(tool|list_dir|read_file|tree)\b/i.test(t)
  )
}

export function talksAboutToolsWithoutCalling(text: string): boolean {
  if (parseToolCalls(text).length > 0) return false
  const longPlan = (text.match(/^\s*\d+\.\s+/gm) || []).length >= 5
  return mentionsTools(text) || longPlan
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
  // Completed work is often summarized as a numbered list. Reject a plan,
  // not the list formatting itself; observed mutations/verification gate success.
  if (
    (t.match(/^\s*\d+\.\s+/gm) || []).length >= 3 &&
    !/\b(done|completed|finished|created|updated|implemented)\b/i.test(t)
  )
    return false
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
  if (asksWhatTheProjectDoes(text)) return false
  if (asksForRecommendations(text)) return true
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

/** A promise to inspect files is progress narration, not the requested answer. */
export function isUnfinishedWorkNarration(text: string): boolean {
  return /(?:^|\n)\s*(?:I (?:still )?need to (?:read|inspect|check|review|look|gather|examine)|I(?: will| shall|'ll|’ll) (?:now )?(?:read|inspect|check|review|look|gather|examine)|Let me (?:now )?(?:read|inspect|check|review|look|gather|examine))\b/i.test(
    stripToolBlocks(text).trim()
  )
}

/** Workspace task still needs tool work — keep the loop alive. */
export function shouldKeepWorking(opts: {
  needsTools: boolean
  mutated: boolean
  assistantText: string
  reviewOnly?: boolean
  inspectRounds?: number
  actions?: string[]
  /** User asked what the open project does. Finish only with a sourced description. */
  describeProject?: boolean
  /** Read-only chat turn. Stop once the reply explains what was read. */
  chatReply?: boolean
}): boolean {
  const {
    needsTools,
    mutated,
    assistantText,
    reviewOnly,
    inspectRounds = 0,
    actions = [],
    describeProject = false,
    chatReply = false
  } = opts
  if (!needsTools) return false
  if (describeProject) return !projectDescriptionReady(assistantText, actions)
  if (chatReply) {
    if (parseToolCalls(assistantText).length > 0) return true
    const note = stripToolBlocks(assistantText).trim()
    const readSource = actions.some((action) => /^Read (?!\.eris\/)/.test(action))
    if (isUnfinishedWorkNarration(note)) return true
    if (note.length >= 40 && (readSource || inspectRounds >= 1)) return false
    return true
  }
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

/** Why a reply without tool calls did not end the run. Never includes its text. */
export function rejectedReplyReason(assistantText: string, actions: string[]): string {
  const note = stripToolBlocks(assistantText).trim()
  if (!note) return 'tool-text-only'
  if (looksLikeRefusal(assistantText)) return 'refusal'
  if (looksLikeAsksForWorkspaceInfo(assistantText)) return 'asks-for-workspace-info'
  if (mentionsTools(assistantText)) return 'describes-tools'
  if (looksLikeDegenerateLoop(assistantText)) return 'degenerate-loop'
  if (isUnfinishedWorkNarration(note)) return 'unfinished-work'
  if (!actions.some((action) => /^Read (?!\.eris\/)/.test(action))) return 'no-source-evidence'
  return 'not-complete'
}

export function toolFingerprint(calls: ToolCall[]): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)])
      )
    return value
  }
  // IDs and formatting do not affect identity; all executable arguments do.
  // Hash content rather than retaining source code or commands in diagnostics.
  return createHash('sha256')
    .update(
      JSON.stringify(
        calls.map((call) => ({
          name: call.name,
          args: canonical(call.args),
          ...(call.parseError ? { invalid: call.raw } : {})
        }))
      )
    )
    .digest('hex')
}

/** User asked for a packaged / native / installable app artifact. */
export function goalWantsPackagedApp(goal: string): boolean {
  const t = goal.toLowerCase()
  return (
    /\.app\b/.test(t) ||
    /\b(dmg|pkg|notar|electron-builder|xcodebuild|xcode)\b/.test(t) ||
    /\b(macos|mac\s*os|osx)\b[\s\S]{0,40}\b(app|application)\b/.test(t) ||
    /\bbuild\b[\s\S]{0,40}\b(calculator\.app|[\w-]+\.app)\b/.test(t)
  )
}

/** Successful build / package signal in the action log. */
export function actionLogHasBuildSuccess(actions: string[]): boolean {
  return actions.some((a) =>
    /\b(verify passed|build (ok|passed|succeeded)|xcodebuild|electron-builder|npm run (dist|build|package)|dist:mac|created .*\.app)\b/i.test(
      a
    )
  )
}

/**
 * True when the latest mutating tool attempt failed (no successful write after it).
 * Example: Failed search_replace as the last edit → do not accept DONE.
 */
export function trailingMutationFailed(actions: string[]): boolean {
  const mut = actions.filter(
    (a) =>
      /^Failed (?:write_file|search_replace|apply_patch|mkdir|delete_path|rename_path)\b/i.test(
        a
      ) || /\b(?:Wrote|Created|Updated|Patched|Replaced|Deleted|Renamed)\b/i.test(a)
  )
  if (mut.length === 0) return false
  let lastFail = -1
  for (let i = 0; i < mut.length; i++) {
    if (/^Failed\b/i.test(mut[i]!)) lastFail = i
  }
  if (lastFail < 0) return false
  return !mut.slice(lastFail + 1).some((a) => !/^Failed\b/i.test(a))
}

export type GoalAssessment = {
  unmet: boolean
  reason: string
}

/**
 * Cheap pre-DONE gate: reject victory laps when tools failed, stubs were written,
 * or a packaged .app was requested but never built.
 */
export function assessGoalCompletion(opts: {
  goal: string
  assistantText: string
  actionLog: string[]
  filesTouched: string[]
  codeMutated: boolean
  reviewOnly: boolean
  /** True when every touched product file is tiny (caller measures on disk). */
  onlyTinyStubs?: boolean
  verifyPassed?: boolean
}): GoalAssessment {
  const {
    goal,
    assistantText,
    actionLog,
    filesTouched,
    codeMutated,
    reviewOnly,
    onlyTinyStubs = false,
    verifyPassed = false
  } = opts

  if (reviewOnly) return { unmet: false, reason: '' }
  if (!looksLikeTaskComplete(assistantText) && !/\bfinished\b/i.test(assistantText)) {
    // Loop only calls this when about to accept DONE; still allow check.
  }

  if (trailingMutationFailed(actionLog)) {
    return {
      unmet: true,
      reason:
        'Recent write/search_replace tools failed. Fix those edits (or use write_file) before finishing.'
    }
  }

  if (goalWantsPackagedApp(goal)) {
    const hasAppPath = filesTouched.some((f) => /\.app(\/|$)/i.test(f))
    if (!hasAppPath && !actionLogHasBuildSuccess(actionLog) && !verifyPassed) {
      return {
        unmet: true,
        reason:
          'User asked for a packaged .app / macOS build. Run the real build (xcodebuild, electron-builder, npm run dist:mac, etc.) or produce the .app — do not finish after a tiny source stub.'
      }
    }
  }

  if (codeMutated && onlyTinyStubs && filesTouched.length > 0) {
    const ambitious =
      /\b(build|create|implement|scaffold|app|application|calculator|project)\b/i.test(goal)
    if (ambitious) {
      return {
        unmet: true,
        reason:
          'Only tiny stub files were written. Implement a real working solution for the user request before DONE.'
      }
    }
  }

  // Claimed finished but never mutated on an edit-shaped goal
  if (
    !codeMutated &&
    /\b(build|create|implement|fix|add|scaffold|make)\b/i.test(goal) &&
    looksLikeTaskComplete(assistantText)
  ) {
    return {
      unmet: true,
      reason:
        'No product files were changed. Use write_file / search_replace to implement the request.'
    }
  }

  return { unmet: false, reason: '' }
}
