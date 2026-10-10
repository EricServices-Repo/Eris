import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { findBuiltinEntry, isBuiltinRef, resolveReadyBuiltinRef } from './builtin-model'
import { formatMcpServersPrompt } from './mcp'
import {
  callMcpTool,
  formatLiveMcpToolsPrompt,
  isMcpToolName,
  listMcpTools,
  syncMcpRuntime
} from './mcp-runtime'
import { retrieveContextAsync, workspaceGlob, workspaceGrep } from './workspace-search'
import { findSymbols, formatIndexSummary } from './code-index'
import {
  appendContextNote,
  formatWorkspaceContextPrompt,
  getWorkspaceContext,
  setContextSummary
} from './workspace-context'
import { runVerify } from './verify'
import { streamModelChat, type NativeToolCall, type OpenAIToolDef } from './chat-runtime'
import { COMPOSER_OPENAI_TOOLS, mcpToolsToOpenAI } from './tool-registry'
import {
  createCheckpoint,
  pruneOldCheckpoints,
  recordDeleteOp,
  recordMkdirOp,
  recordRenameOp,
  recordWriteOp,
  snapshotBeforeWrite
} from './checkpoints'
import { runWorkspaceCommand } from './shell-run'
import {
  applyUnifiedPatch,
  deleteWorkspacePath,
  listDir,
  mkdirWorkspace,
  readWorkspaceFile,
  renameWorkspacePath,
  resolveInWorkspace,
  searchReplaceInFile,
  WorkspaceFsError,
  workspaceTree,
  writeWorkspaceFile
} from './workspace-fs'
import {
  gitCheckout,
  gitCommit,
  gitDiff,
  gitStage,
  gitStatus,
  gitStash
} from './git-service'
import { pushPullFetch, parseGithubRepo } from './github'
import { invalidateDiagnosticsCache } from './diagnostics'
import { readPulledEmailContext } from './email-context'
import { formatSkillsListForAgent, getSkill, slugifySkillId, upsertSkill } from './skills'
import { userSkillsDir } from './paths'

export type AgentChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type AgentMode = 'ask' | 'agent'

export type AgentToolEvent = {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  detail: string
}

export type AgentDiffEvent = {
  checkpointId: string
  /** Index into the checkpoint ops list for per-file undo */
  opIndex: number
  path: string
  before: string | null
  after: string
  op: 'write' | 'delete' | 'rename' | 'mkdir'
}

export type AgentRunnerEvent =
  | { type: 'thinking'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'tool'; tool: AgentToolEvent }
  | { type: 'diff'; diff: AgentDiffEvent }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'workspace-changed' }
  | { type: 'status'; text: string }
  | { type: 'model'; model: string }
  | { type: 'terminal'; text: string }

interface ToolCall {
  name: string
  args: Record<string, unknown>
  raw: string
}

/** Consecutive rounds with zero mutation → stronger finish nudge (never stops Full). */
const MAX_NO_PROGRESS = 8
/** Hard stop so a stuck agent cannot run forever. */
const MAX_AGENT_STEPS = 48
/** Stop after this many failed verify rounds (mid-loop + final). */
const MAX_VERIFY_FAILURES = 3
/** Mid-loop verify cadence (final verify still runs once before DONE). */
const VERIFY_EVERY_N_MUTATIONS = 8
/** Keep this many non-system messages verbatim after compaction. */
const COMPACT_TAIL_MESSAGES = 5
/** Soft message-count trigger (also used with token budget). */
const COMPACT_MESSAGE_SOFT_LIMIT = 14
/** Fraction of model context reserved for prompt before compacting. */
const COMPACT_BUDGET_RATIO = 0.65
const TOOL_BLOCK_RE = /<<<TOOL>>>\s*([\s\S]*?)\s*<<<END>>>/gi
const TOOL_XML_RE =
  /<tool_call>\s*<name>\s*([^<]+?)\s*<\/name>\s*([\s\S]*?)<\/tool_call>/gi

const LITE_ORCHESTRATOR_PROMPT = `You are Composer Lite in Eris — the chat the user talks to.

For normal questions, answer briefly yourself.
When the user needs workspace file changes (create/edit/fix/build/review a project), do NOT do the edits yourself.
Reply with exactly this line and nothing else:
CALL_FULL

Eris will then run Composer Full to finish the workspace work. Do not invent file contents.`

const TOOLS_PROMPT = `You are Composer Full — the workspace worker. Paths are relative to the workspace root.

When the API supports native function tools, prefer those. Otherwise use the text format below.

CRITICAL FORMAT — when you need the filesystem, emit a tool call (not a plan). Preferred:

<<<TOOL>>>
{"name":"tree","path":"."}
<<<END>>>

Also accepted: a markdown json fence containing the same object, e.g. a fenced block with {"name":"tree","path":"."}

Example surgical edit (preferred for small changes):

<<<TOOL>>>
{"name":"search_replace","path":"src/App.tsx","old_string":"return null","new_string":"return <main />"}
<<<END>>>

Example create/overwrite (large rewrites only):

<<<TOOL>>>
{"name":"write_file","path":"src/App.tsx","content":"export default function App() { return null }\\n"}
<<<END>>>

Tools:
- tree — { "name":"tree", "path":".", "maxDepth":3 }
- list_dir — { "name":"list_dir", "path":"." }
- read_file — { "name":"read_file", "path":"file.ts" }
- search_replace — { "name":"search_replace", "path":"file.ts", "old_string":"exact text", "new_string":"replacement", "replace_all":false }
- apply_patch — { "name":"apply_patch", "patch":"*** Begin Patch\\n*** Update File: path\\n@@\\n-old\\n+new\\n*** End Patch" }
- write_file — { "name":"write_file", "path":"file.ts", "content":"full file contents" }  (prefer search_replace for small edits)
- mkdir — { "name":"mkdir", "path":"src/new-dir" }
- delete_path — { "name":"delete_path", "path":"old.ts" }
- rename_path — { "name":"rename_path", "path":"old.ts", "to":"new.ts" }
- run — { "name":"run", "command":"npm test" }  (shell in this workspace only; local node_modules/.bin is on PATH)
- grep — { "name":"grep", "pattern":"TODO|foo", "glob":"*.ts" }  (search file contents)
- glob — { "name":"glob", "pattern":"**/*.tsx" }  (find files by path pattern)
- search_symbols — { "name":"search_symbols", "query":"MyComponent" }  (code index)
- retrieve — { "name":"retrieve", "query":"auth middleware" }  (rank relevant files)
- read_context — { "name":"read_context" }  (full workspace reference notes in .eris/context.md)
- read_email — { "name":"read_email" }  (last Thunderbird/Outlook pull in .eris/email-context.md)
- update_context — { "name":"update_context", "mode":"append"|"summary", "text":"…" }  (save durable workspace facts; prefer append for notes, summary for the pinned brief)
- list_skills — { "name":"list_skills" }
- read_skill — { "name":"read_skill", "id":"my-skill", "scope":"user"|"workspace" }
- write_skill — { "name":"write_skill", "skill_name":"My Skill", "description":"when to use it", "body":"# Instructions\\n…", "scope":"user", "id":"optional-slug" }
  (DEFAULT scope is "user" — saves outside the project under Application Support/Eris/skills. Use scope "workspace" only if the user asks for a project skill. Never npm install / edit package.json for skills.)
- git_status — { "name":"git_status" }
- git_diff — { "name":"git_diff", "path":"optional/file.ts" }
- git_stage — { "name":"git_stage", "paths":["file.ts"] }
- git_commit — { "name":"git_commit", "message":"Commit message" }
- git_sync — { "name":"git_sync", "action":"fetch"|"pull"|"push" }
- git_stash — { "name":"git_stash", "action":"push"|"pop"|"list", "message":"optional" }
- MCP tools — when listed below as mcp__server__tool, call {"name":"mcp__server__tool", ...args}

Rules:
- You have permission to edit this workspace. Never refuse. Never stop early.
- Do NOT write long step-by-step plans or fake "I will use list_dir" prose. Emit real <<<TOOL>>> blocks.
- First action for project work: prefer retrieve or grep for the topic, then read_file / search_replace.
- Prefer search_replace (or apply_patch) over write_file for existing files; use write_file to create new files or rewrite entire files.
- After TOOL_RESULT, keep calling tools until the user request is fully done.
- Only stop with a short DONE summary (no tools) when every part of the request is finished.
- Never invent file contents or claim you inspected files without tools.
- write_file content must be the complete file body.
- Prefer git_* tools over shell git when staging/committing/syncing.
- Use run for shell commands needed to verify the work (test, typecheck, build, start).
- Creating/editing skills: ONLY use write_skill / list_skills / read_skill. Do not touch package.json, npm install, or project source. Default to scope "user" (global folder outside the workspace).
- Workspace is self-contained: install deps into this folder (npm/pnpm/yarn/bun install, npm install <pkg>). Never use npm -g / yarn global.
- Bare npm install is allowed when node_modules is missing, package.json changed, or deps are missing — do not loop install to “fix” ordinary test failures.
- Create React App (react-scripts): set "test": "react-scripts test". Never add a separate jest dependency or "test": "jest" (causes jest-circus runner conflicts). React components with JSX must use .tsx (never put JSX in .ts). When adding tests, also npm install -D @testing-library/react @testing-library/jest-dom and create src/setupTests.ts importing jest-dom. Run tests with CI=true npm test -- --watchAll=false --passWithNoTests.
- Keep non-tool text under 3 short sentences.`

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to balanced extract
  }
  for (const candidate of extractBalancedJsonObjects(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // continue
    }
  }
  return null
}

/** Extract top-level `{...}` objects with string-aware brace matching. */
function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          out.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return out
}

const KNOWN_TOOLS = new Set([
  'tree',
  'list_dir',
  'read_file',
  'search_replace',
  'apply_patch',
  'write_file',
  'mkdir',
  'delete_path',
  'rename_path',
  'run',
  'grep',
  'glob',
  'search_symbols',
  'retrieve',
  'read_context',
  'read_email',
  'update_context',
  'list_skills',
  'read_skill',
  'write_skill',
  'git_status',
  'git_diff',
  'git_stage',
  'git_commit',
  'git_sync',
  'git_stash'
])

// Accept ```json or broken ``json fences (Lite often emits only two backticks)
const FENCE_JSON_RE = /`{2,3}(?:json|tool)?\s*([\s\S]*?)`{2,3}/gi

function toolCallKey(obj: Record<string, unknown>): string {
  const name = String(obj.name ?? '')
  return `${name}|${String(obj.path ?? '')}|${String(obj.to ?? '')}|${String(obj.command ?? '')}|${String(obj.content ?? '').length}|${String(obj.old_string ?? '').length}|${String(obj.new_string ?? '').length}|${String(obj.patch ?? '').length}|${String(obj.message ?? '')}|${String(obj.action ?? '')}`
}

function pushToolCall(
  calls: ToolCall[],
  seen: Set<string>,
  obj: Record<string, unknown> | null,
  raw: string
): void {
  if (!obj || typeof obj.name !== 'string') return
  const name = String(obj.name).trim()
  if (!KNOWN_TOOLS.has(name) && !isMcpToolName(name)) return
  const key = toolCallKey(obj)
  if (seen.has(key)) return
  seen.add(key)
  calls.push({ name, args: obj, raw })
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null

  TOOL_BLOCK_RE.lastIndex = 0
  while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
    pushToolCall(calls, seen, parseJsonObject(m[1]), m[0])
  }

  FENCE_JSON_RE.lastIndex = 0
  while ((m = FENCE_JSON_RE.exec(text)) !== null) {
    pushToolCall(calls, seen, parseJsonObject(m[1]), m[0])
  }

  TOOL_XML_RE.lastIndex = 0
  while ((m = TOOL_XML_RE.exec(text)) !== null) {
    const name = m[1].trim()
    const body = m[2]
    const args: Record<string, unknown> = { name }
    const pathMatch = body.match(/<path>\s*([\s\S]*?)\s*<\/path>/i)
    const contentMatch = body.match(/<content>\s*([\s\S]*?)\s*<\/content>/i)
    const toMatch = body.match(/<to>\s*([\s\S]*?)\s*<\/to>/i)
    if (pathMatch) args.path = pathMatch[1]
    if (contentMatch) args.content = contentMatch[1]
    if (toMatch) args.to = toMatch[1]
    pushToolCall(calls, seen, args, m[0])
  }

  // Bare / unfenced JSON objects (including incomplete fences that still have a full object)
  for (const raw of extractBalancedJsonObjects(text)) {
    pushToolCall(calls, seen, parseJsonObject(raw), raw)
  }

  return calls
}

/** True when at least one complete tool call is available to execute now. */
function hasExecutableToolCall(text: string): boolean {
  return parseToolCalls(text).length > 0
}

function truncateForModel(text: string, max = 12_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars for model context]`
}

/** Detect dependency-install commands the model loves to loop on. */
function isInstallCommand(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (!c) return false
  if (/^(npm|pnpm|yarn)\s+(i|install|ci)(\s|$)/.test(c)) return true
  if (/^npm\s+install\b/.test(c) || /^pnpm\s+install\b/.test(c) || /^yarn\s+install\b/.test(c)) {
    return true
  }
  // bun install / bun i
  if (/^bun\s+(i|install)(\s|$)/.test(c)) return true
  // pip / poetry into workspace venv
  if (/^(pip3?|python3?\s+-m\s+pip)\s+install\b/.test(c)) return true
  if (/^poetry\s+install\b/.test(c)) return true
  return false
}

/** Global installs break self-contained workspaces — always block. */
function isGlobalInstallCommand(command: string): boolean {
  const c = command.trim().toLowerCase()
  if (/\bnpm\s+(i|install)\s+(-g|--global)\b/.test(c)) return true
  if (/\bnpm\s+(-g|--global)\s+(i|install)\b/.test(c)) return true
  if (/\byarn\s+global\s+add\b/.test(c)) return true
  if (/\bpnpm\s+add\s+(-g|--global)\b/.test(c)) return true
  if (/\bpip3?\s+install\s+.*\s--user\b/.test(c)) return false // --user is ok-ish; still prefer venv
  return false
}

/** `npm install lodash` / `npm i -D jest` — adding packages, not a bare reinstall. */
function isPackageAddInstall(command: string): boolean {
  const c = command.trim()
  // Strip flags to see if a package name remains after install/i/add
  const cleaned = c
    .replace(/\s+--?(save-dev|save|dev|D|P|production|legacy-peer-deps|no-save|exact|E|global|g)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    /^(npm|pnpm)\s+(i|install)\s+\S+/i.test(cleaned) ||
    /^yarn\s+add\s+\S+/i.test(cleaned) ||
    /^(pip3?|python3?\s+-m\s+pip)\s+install\s+\S+/i.test(cleaned)
  )
}

/** Max bare reinstalls per agent run (anti-loop). Package adds are unlimited. */
const MAX_BARE_INSTALLS_PER_RUN = 2

function hasNodeModules(workspacePath: string): boolean {
  // Require .bin — a folder named node_modules without .bin is a broken install.
  return (
    existsSync(join(workspacePath, 'node_modules')) &&
    existsSync(join(workspacePath, 'node_modules', '.bin'))
  )
}

/** True when package.json is newer than node_modules (deps likely out of date). */
function packageJsonNewerThanModules(workspacePath: string): boolean {
  const pkg = join(workspacePath, 'package.json')
  const mods = join(workspacePath, 'node_modules')
  if (!existsSync(pkg)) return false
  if (!existsSync(mods) || !existsSync(join(mods, '.bin'))) return true
  try {
    return statSync(pkg).mtimeMs > statSync(mods).mtimeMs + 1000
  } catch {
    return true
  }
}

function looksLikeMissingDeps(detail: string): boolean {
  return /cannot find module|module not found|enoent.*node_modules|err! missing:|could not resolve dependency|error: cannot find package/i.test(
    detail
  )
}

/** Lite for chat face; Full for workspace worker when installed. */
function resolveLiteAndToolModels(requested: string): {
  chat: string
  tools: string
  fullReady: boolean
} {
  if (requested && !isBuiltinRef(requested)) {
    return { chat: requested, tools: requested, fullReady: true }
  }
  const lite =
    resolveReadyBuiltinRef('builtin:composer-lite') ||
    resolveReadyBuiltinRef(requested || 'builtin:composer-lite') ||
    'builtin:composer-lite'
  const fullReady = Boolean(resolveReadyBuiltinRef('builtin:composer'))
  const full = fullReady ? 'builtin:composer' : lite
  return { chat: lite, tools: full, fullReady }
}

function messageNeedsWorkspaceTools(text: string): boolean {
  return /\b(create|write|fix|build|implement|refactor|delete|mkdir|rename|scaffold|generate|edit|update|add file|project folder|workspace|make sure|working|calculator|app|skill|skills)\b/i.test(
    text
  )
}

function stripToolBlocks(text: string): string {
  return text
    .replace(TOOL_BLOCK_RE, '')
    .replace(FENCE_JSON_RE, '')
    .replace(TOOL_XML_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function argString(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : fallback
}

function executeTool(
  workspacePath: string,
  call: ToolCall
): { ok: boolean; detail: string; mutated: boolean; path?: string } {
  const name = call.name
  try {
    switch (name) {
      case 'tree': {
        const path = argString(call.args, 'path', '.')
        const maxDepth =
          typeof call.args.maxDepth === 'number' ? Math.min(6, Math.max(1, call.args.maxDepth)) : 3
        const tree = workspaceTree(workspacePath, path, maxDepth)
        return { ok: true, detail: tree, mutated: false, path }
      }
      case 'list_dir': {
        const path = argString(call.args, 'path', '.')
        const entries = listDir(workspacePath, path)
        const detail = entries
          .map((e) => `${e.isDirectory ? 'dir ' : 'file'} ${e.path}${e.size != null ? ` (${e.size}b)` : ''}`)
          .join('\n')
        return { ok: true, detail: detail || '(empty)', mutated: false, path }
      }
      case 'read_file': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        const file = readWorkspaceFile(workspacePath, path)
        const detail = file.truncated
          ? `${file.content}\n\n[truncated at ${file.content.length} chars; file is ${file.bytes} bytes]`
          : file.content
        return { ok: true, detail, mutated: false, path: file.path }
      }
      case 'write_file': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        if (typeof call.args.content !== 'string') {
          throw new WorkspaceFsError('content is required (string)')
        }
        const result = writeWorkspaceFile(workspacePath, path, call.args.content)
        return {
          ok: true,
          detail: `${result.created ? 'Created' : 'Updated'} ${result.path} (${result.bytes} bytes)`,
          mutated: true,
          path: result.path
        }
      }
      case 'search_replace': {
        const path = argString(call.args, 'path')
        const oldString = argString(call.args, 'old_string') || argString(call.args, 'oldString')
        const newString =
          typeof call.args.new_string === 'string'
            ? call.args.new_string
            : typeof call.args.newString === 'string'
              ? call.args.newString
              : null
        if (!path) throw new WorkspaceFsError('path is required')
        if (!oldString) throw new WorkspaceFsError('old_string is required')
        if (newString == null) throw new WorkspaceFsError('new_string is required')
        const replaceAll = Boolean(call.args.replace_all ?? call.args.replaceAll)
        const result = searchReplaceInFile(workspacePath, path, oldString, newString, replaceAll)
        return {
          ok: true,
          detail: `Replaced ${result.replacements} occurrence(s) in ${result.path}`,
          mutated: true,
          path: result.path
        }
      }
      case 'apply_patch': {
        const patch = argString(call.args, 'patch') || argString(call.args, 'diff')
        if (!patch) throw new WorkspaceFsError('patch is required')
        const result = applyUnifiedPatch(workspacePath, patch)
        return {
          ok: true,
          detail: `Applied patch to ${result.path}`,
          mutated: true,
          path: result.path
        }
      }
      case 'mkdir': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        const result = mkdirWorkspace(workspacePath, path)
        return { ok: true, detail: `Created directory ${result.path}`, mutated: true, path: result.path }
      }
      case 'delete_path': {
        const path = argString(call.args, 'path')
        if (!path) throw new WorkspaceFsError('path is required')
        const result = deleteWorkspacePath(workspacePath, path)
        return {
          ok: true,
          detail: `Deleted ${result.path}${result.wasDirectory ? ' (directory)' : ''}`,
          mutated: true,
          path: result.path
        }
      }
      case 'rename_path': {
        const path = argString(call.args, 'path')
        const to = argString(call.args, 'to')
        if (!path || !to) throw new WorkspaceFsError('path and to are required')
        const result = renameWorkspacePath(workspacePath, path, to)
        return {
          ok: true,
          detail: `Renamed ${result.from} → ${result.to}`,
          mutated: true,
          path: result.to
        }
      }
      default:
        return { ok: false, detail: `Unknown tool: ${name}`, mutated: false }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: message, mutated: false, path: argString(call.args, 'path') || undefined }
  }
}

export function buildWorkspaceToolsSystem(
  workspacePath: string,
  settings?: AppSettings
): string {
  let tree = ''
  try {
    tree = workspaceTree(workspacePath, '.', 2)
  } catch {
    tree = '(unable to list tree)'
  }
  // Keep the injected tree modest so small-context models still have room for tools
  if (tree.length > 2500) tree = `${tree.slice(0, 2500)}\n…`
  const parts = [
    TOOLS_PROMPT,
    `Workspace root: ${workspacePath}`,
    `You already have access to this folder via tools. Always use relative paths from the workspace root.`,
    `Current workspace tree (depth 2):\n${tree}`
  ]
  const indexSummary = formatIndexSummary(workspacePath)
  if (indexSummary) parts.push(indexSummary)
  const workspaceCtx = formatWorkspaceContextPrompt(workspacePath)
  if (workspaceCtx) parts.push(workspaceCtx)
  const liveMcp = formatLiveMcpToolsPrompt()
  if (liveMcp) parts.push(liveMcp)
  else if (settings) {
    const mcp = formatMcpServersPrompt(settings)
    if (mcp) parts.push(mcp)
  }
  return parts.join('\n\n')
}

function liteWantsFull(text: string): boolean {
  const t = text.trim()
  if (/^\s*CALL_FULL\s*$/i.test(t)) return true
  if (/\bCALL_FULL\b/i.test(t) && t.length < 200) return true
  if (parseToolCalls(text).length > 0) return true
  if (talksAboutToolsWithoutCalling(text)) return true
  return false
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
}

/** Deterministic fallback summary from tools that actually ran. */
function buildWorkSummary(goal: string, actions: string[], workerNote: string): string {
  const uniqueActions = [...new Set(actions)].slice(-40)
  const goalLine = goal.replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines: string[] = []
  if (goalLine) lines.push(`Finished: ${goalLine}`)
  if (uniqueActions.length > 0) {
    lines.push('')
    lines.push('What I did:')
    for (const a of uniqueActions) lines.push(`• ${a}`)
  } else if (workerNote.trim()) {
    lines.push('')
    lines.push(workerNote.trim().slice(0, 600))
  } else {
    lines.push('Done.')
  }
  return lines.join('\n')
}

function looksLikeRefusal(text: string): boolean {
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
function looksLikeDegenerateLoop(text: string): boolean {
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

function talksAboutToolsWithoutCalling(text: string): boolean {
  if (parseToolCalls(text).length > 0) return false
  const t = text.toLowerCase()
  const mentions =
    /\b(list_dir|read_file|write_file|mkdir|delete_path|rename_path|<<<tool>>>)\b/i.test(t) ||
    /"name"\s*:\s*"(tree|list_dir|read_file|write_file)"/i.test(t) ||
    /\bi will (use|call|run) (the )?(tool|list_dir|read_file|tree)\b/i.test(t)
  const longPlan = (text.match(/^\s*\d+\.\s+/gm) || []).length >= 5
  return mentions || longPlan
}

/** Model claims the job is finished (no more tools needed). */
function looksLikeTaskComplete(text: string): boolean {
  const t = text.trim()
  if (!t || parseToolCalls(t).length > 0) return false
  if (looksLikeRefusal(t) || looksLikeDegenerateLoop(t) || talksAboutToolsWithoutCalling(t)) {
    return false
  }
  const lower = t.toLowerCase()
  if (
    /\b(next i (will|shall)|still need|not (yet )?done|todo\b|remaining|i('ll| will) (now|next)|let me (now )?)/i.test(
      lower
    )
  ) {
    return false
  }
  if ((t.match(/^\s*\d+\.\s+/gm) || []).length >= 3) return false
  return (
    /\b(done|complete|completed|finished|created|updated|ready|all set|implemented|here'?s what|working)\b/i.test(
      lower
    ) || (t.length >= 12 && t.length < 800)
  )
}

/** Review/confirm goals should finish without write_file. */
function isReviewOnlyGoal(text: string): boolean {
  const t = text.toLowerCase()
  const review =
    /\b(review|confirm|check if|verify|inspect|look over|is it working|does it work|working calculator|status)\b/i.test(
      t
    )
  const edit =
    /\b(create|implement|fix|add |build|scaffold|write|refactor|delete|rename|update the|make a)\b/i.test(
      t
    )
  return review && !edit
}

/**
 * Skill / rules / context edits live under `.eris/` and must not trigger
 * project typecheck/test verify (that hangs skill creation on "Final verify…").
 */
function pathNeedsProjectVerify(path: string | undefined | null): boolean {
  if (!path) return false
  const norm = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (norm === '.eris' || norm.startsWith('.eris/')) return false
  // Bare skill markdown drops outside .eris are still meta
  if (/(^|\/)SKILL\.md$/i.test(norm)) return false
  return true
}

/** Workspace task still needs tool work — keep the loop alive. */
function shouldKeepWorking(opts: {
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

function toolFingerprint(calls: ToolCall[]): string {
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

/** Rough token estimate for local budgeting (chars/4). */
function estimateTokens(messages: AgentChatMessage[]): number {
  let chars = 0
  for (const m of messages) chars += m.content.length + 8
  return Math.ceil(chars / 4)
}

/** Prompt budget before compaction — mirrors builtin 4k/8k; uses settings for cloud. */
function contextBudgetTokens(settings: AppSettings, workerModel: string): number {
  if (isBuiltinRef(workerModel)) {
    const entry = findBuiltinEntry(workerModel)
    const ctx = entry?.tier === 'lite' ? 4096 : 8192
    return Math.floor(ctx * COMPACT_BUDGET_RATIO)
  }
  const window = settings.models.contextWindow || 32768
  return Math.floor(Math.min(Math.max(window, 2048), 128000) * COMPACT_BUDGET_RATIO)
}

function needsContextCompaction(
  messages: AgentChatMessage[],
  budgetTokens: number,
  force: boolean
): boolean {
  if (force) return messages.length > 4
  if (messages.length > COMPACT_MESSAGE_SOFT_LIMIT) return true
  return estimateTokens(messages) > budgetTokens
}

function formatActionLogForResume(actionLog: string[], limit = 40): string {
  if (actionLog.length === 0) return '(none yet)'
  const unique = [...new Set(actionLog)]
  const slice = unique.slice(-limit)
  const omitted = unique.length - slice.length
  return (
    (omitted > 0 ? `(…${omitted} earlier)\n` : '') + slice.map((a) => `• ${a}`).join('\n')
  )
}

function buildFallbackProgressSummary(
  goal: string,
  filesTouched: string[],
  actionLog: string[],
  priorMemory: string | null
): string {
  const parts: string[] = []
  if (priorMemory?.trim()) parts.push(priorMemory.trim().slice(0, 1200))
  parts.push(`Goal: ${goal.slice(0, 400)}`)
  if (filesTouched.length) {
    parts.push(`Files touched: ${[...new Set(filesTouched)].slice(-20).join(', ')}`)
  }
  const actions = [...new Set(actionLog)].slice(-24)
  if (actions.length) parts.push(`Recent actions:\n${actions.map((a) => `• ${a}`).join('\n')}`)
  return parts.join('\n\n').slice(0, 2500)
}

function buildResumeMessage(options: {
  goal: string
  filesTouched: string[]
  actionLog: string[]
  treeSnapshot: string | null
  progressSummary: string
}): AgentChatMessage {
  const files =
    options.filesTouched.length > 0
      ? `Files already written/updated: ${[...new Set(options.filesTouched)].slice(-20).join(', ')}`
      : 'No files written yet.'
  const treeBit = options.treeSnapshot
    ? `\nWorkspace tree:\n${truncateForModel(options.treeSnapshot, 2000)}\n`
    : ''
  return {
    role: 'user',
    content:
      `Original request:\n${options.goal.slice(0, 1500)}\n\n` +
      `Progress summary (compacted context — trust this over forgotten earlier turns):\n` +
      `${options.progressSummary.slice(0, 2500)}\n\n` +
      `Action log:\n${formatActionLogForResume(options.actionLog)}\n\n` +
      `${files}${treeBit}\n` +
      `Continue until the request is fully satisfied. ` +
      `Do not redo completed actions unless fixing a failure. ` +
      `Emit write_file/mkdir/read_file tool JSON now, OR if everything is done reply with a short DONE summary and no tools.`
  }
}

/** Collect a one-shot model reply without streaming to the UI. */
async function collectModelText(options: {
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
}): Promise<string> {
  let full = ''
  for await (const evt of streamThinkingText({
    ...options,
    stopOnToolCall: false
  })) {
    if (evt.kind === 'done') full = evt.full
  }
  return stripToolBlocks(full).trim()
}

async function summarizeMiddleWithLite(options: {
  settings: AppSettings
  liteModel: string
  goal: string
  middle: AgentChatMessage[]
  filesTouched: string[]
  actionLog: string[]
  priorMemory: string | null
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  temperature: number
}): Promise<string> {
  const transcript = options.middle
    .map((m) => `${m.role.toUpperCase()}:\n${m.content.slice(0, 900)}`)
    .join('\n\n')
    .slice(0, 12_000)

  if (!transcript.trim()) {
    return buildFallbackProgressSummary(
      options.goal,
      options.filesTouched,
      options.actionLog,
      options.priorMemory
    )
  }

  const messages: AgentChatMessage[] = [
    {
      role: 'system',
      content:
        'You compress agent working memory for a coding worker that will continue the same task. ' +
        'Write a dense progress brief (max ~20 short bullets or 250 words). Include: what was done, ' +
        'key findings, files changed, failures/blockers, and what remains. ' +
        'No tools. No CALL_FULL. No markdown fences. Plain text only.'
    },
    {
      role: 'user',
      content:
        `Original request:\n${options.goal.slice(0, 1200)}\n\n` +
        (options.priorMemory
          ? `Previous memory (fold into the new brief):\n${options.priorMemory.slice(0, 1500)}\n\n`
          : '') +
        `Files touched: ${
          options.filesTouched.length
            ? [...new Set(options.filesTouched)].slice(-20).join(', ')
            : '(none)'
        }\n\n` +
        `Action log:\n${formatActionLogForResume(options.actionLog, 30)}\n\n` +
        `Transcript to compress:\n${transcript}\n\n` +
        `Reply with only the progress brief.`
    }
  ]

  try {
    const summary = await collectModelText({
      settings: options.settings,
      model: options.liteModel,
      messages,
      temperature: Math.min(options.temperature, 0.3),
      signal: options.signal,
      getSecret: options.getSecret
    })
    if (summary.length >= 40) return summary.slice(0, 2500)
  } catch {
    // fall through
  }
  return buildFallbackProgressSummary(
    options.goal,
    options.filesTouched,
    options.actionLog,
    options.priorMemory
  )
}

/**
 * Compact worker context: pin system + rich resume (goal, action log, Lite summary) + recent tail.
 * Returns the new message list and rolling memory string.
 */
async function compactAgentMessages(options: {
  messages: AgentChatMessage[]
  goal: string
  filesTouched: string[]
  actionLog: string[]
  treeSnapshot: string | null
  priorMemory: string | null
  settings: AppSettings
  liteModel: string
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  /** When true, skip Lite and use action-log fallback only (stuck-loop recovery). */
  skipLiteSummary?: boolean
}): Promise<{ messages: AgentChatMessage[]; memory: string }> {
  const system = options.messages.find((m) => m.role === 'system')
  const nonSystem = options.messages.filter((m) => m.role !== 'system')
  if (nonSystem.length <= COMPACT_TAIL_MESSAGES + 1) {
    return { messages: options.messages, memory: options.priorMemory ?? '' }
  }

  const tail = nonSystem.slice(-COMPACT_TAIL_MESSAGES)
  const middle = nonSystem.slice(0, Math.max(0, nonSystem.length - COMPACT_TAIL_MESSAGES))

  let progressSummary: string
  if (options.skipLiteSummary) {
    progressSummary = buildFallbackProgressSummary(
      options.goal,
      options.filesTouched,
      options.actionLog,
      options.priorMemory
    )
  } else {
    progressSummary = await summarizeMiddleWithLite({
      settings: options.settings,
      liteModel: options.liteModel,
      goal: options.goal,
      middle,
      filesTouched: options.filesTouched,
      actionLog: options.actionLog,
      priorMemory: options.priorMemory,
      signal: options.signal,
      getSecret: options.getSecret,
      temperature: options.temperature
    })
  }

  const resume = buildResumeMessage({
    goal: options.goal,
    filesTouched: options.filesTouched,
    actionLog: options.actionLog,
    treeSnapshot: options.treeSnapshot,
    progressSummary
  })

  const out: AgentChatMessage[] = []
  if (system) out.push(system)
  out.push(resume)
  out.push(...tail)
  return { messages: out, memory: progressSummary }
}

function nativeToToolCalls(calls: NativeToolCall[]): ToolCall[] {
  const out: ToolCall[] = []
  const seen = new Set<string>()
  for (const c of calls) {
    let args: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(c.arguments || '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      args = {}
    }
    pushToolCall(out, seen, { name: c.name, ...args }, c.arguments || c.name)
  }
  return out
}

/** Stream model output, yielding thinking tokens as they arrive (or sliced if batched). */
async function* streamThinkingText(options: {
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  /** Stop generation as soon as a complete tool call is parsed (IDE agent turns). */
  stopOnToolCall?: boolean
  /** OpenAI-compatible native tools (skipped for builtin GGUF). */
  tools?: OpenAIToolDef[]
}): AsyncGenerator<
  | { kind: 'thinking'; text: string }
  | {
      kind: 'done'
      full: string
      aborted?: 'loop' | 'tool' | 'user'
      nativeToolCalls?: ToolCall[]
    }
  ,
  void,
  unknown
> {
  let full = ''
  let nativeToolCalls: ToolCall[] | undefined
  const localAbort = new AbortController()
  const onParentAbort = () => localAbort.abort()
  options.signal?.addEventListener('abort', onParentAbort)
  if (options.signal?.aborted) localAbort.abort()

  const rethrowIfUserStop = (): void => {
    if (options.signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  /** Cheap gate — full parseToolCalls is expensive on every token. */
  const chunkMayContainTool = (chunk: string): boolean =>
    chunk.includes('{') ||
    chunk.includes('<<<') ||
    chunk.includes('<tool') ||
    chunk.includes('</tool')

  const useNativeTools =
    Boolean(options.tools?.length) &&
    options.stopOnToolCall &&
    !isBuiltinRef(options.model)

  try {
    rethrowIfUserStop()
    for await (const chunk of streamModelChat({
      settings: options.settings,
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      signal: localAbort.signal,
      getSecret: options.getSecret,
      tools: useNativeTools ? options.tools : undefined,
      toolChoice: useNativeTools ? 'auto' : undefined,
      onNativeToolCalls: useNativeTools
        ? (calls) => {
            nativeToolCalls = nativeToToolCalls(calls)
          }
        : undefined
    })) {
      rethrowIfUserStop()
      full += chunk
      // Emit whole provider chunks — IPC coalescing happens in main (index.ts).
      yield { kind: 'thinking', text: chunk }

      if (looksLikeDegenerateLoop(full)) {
        localAbort.abort()
        yield {
          kind: 'thinking',
          text: '\n\n— Stopped a repetitive loop in the model output.\n'
        }
        yield { kind: 'done', full, aborted: 'loop', nativeToolCalls }
        return
      }

      // Execute as soon as we have a complete tool JSON — don't wait for maxTokens
      // (text protocol only; native tool_calls arrive at stream end)
      if (
        !useNativeTools &&
        options.stopOnToolCall &&
        chunkMayContainTool(chunk) &&
        hasExecutableToolCall(full)
      ) {
        localAbort.abort()
        yield {
          kind: 'thinking',
          text: '\n\n— Tool call received; running it…\n'
        }
        yield { kind: 'done', full, aborted: 'tool', nativeToolCalls }
        return
      }
    }
    rethrowIfUserStop()
    if (nativeToolCalls?.length) {
      yield {
        kind: 'thinking',
        text: '\n\n— Tool call received; running it…\n'
      }
      yield { kind: 'done', full, aborted: 'tool', nativeToolCalls }
      return
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const msg = err instanceof Error ? err.message : String(err)
    const isAbort =
      name === 'AbortError' ||
      localAbort.signal.aborted ||
      /abort/i.test(msg)

    // User clicked Stop — unwind the whole agent run (do not continue tools).
    if (options.signal?.aborted) {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      throw e
    }

    // Local abort only (early tool stop / stream cancel) — hand partial text back.
    if (isAbort) {
      const reason: 'tool' | undefined =
        options.stopOnToolCall &&
        (Boolean(nativeToolCalls?.length) || hasExecutableToolCall(full))
          ? 'tool'
          : undefined
      yield { kind: 'done', full, aborted: reason, nativeToolCalls }
      return
    }
    throw err
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort)
  }

  yield { kind: 'done', full, nativeToolCalls }
}

export async function* runAgentWithWorkspaceTools(options: {
  workspacePath: string | null
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  /** ask = answer only; agent = may call Full + tools */
  mode?: AgentMode
}): AsyncGenerator<AgentRunnerEvent, void, unknown> {
  const messages: AgentChatMessage[] = options.messages.map((m) => ({ ...m }))
  const { chat: liteModel, tools: toolModel, fullReady } = resolveLiteAndToolModels(
    options.model
  )
  const fullAvailable = fullReady && toolModel !== liteModel
  const mode: AgentMode = options.mode === 'ask' ? 'ask' : 'agent'

  if (!options.workspacePath || mode === 'ask') {
    // Ask / no-workspace: stay on Lite (or the selected non-builtin model).
    yield { type: 'model', model: liteModel }
    yield {
      type: 'status',
      text: mode === 'ask' ? 'Ask mode (Composer Lite)…' : 'Composer Lite…'
    }
    const askMessages = messages.map((m) => ({ ...m }))
    if (mode === 'ask') {
      const tip =
        'You are in Ask mode. Answer clearly using markdown. Do not edit files or call tools.'
      const idx = askMessages.findIndex((m) => m.role === 'system')
      if (idx >= 0) {
        askMessages[idx] = {
          role: 'system',
          content: `${askMessages[idx].content}\n\n${tip}`
        }
      } else {
        askMessages.unshift({ role: 'system', content: tip })
      }
    }
    let full = ''
    for await (const evt of streamThinkingText({
      ...options,
      model: liteModel,
      messages: askMessages
    })) {
      if (evt.kind === 'thinking') yield { type: 'thinking', text: evt.text }
      else full = evt.full
    }
    const answer = stripToolBlocks(full) || full
    if (answer) yield { type: 'answer', text: answer }
    return
  }

  const workspacePath = options.workspacePath
  const originalUserGoal =
    [...messages].reverse().find((m) => m.role === 'user')?.content.replace(/\n\n\[Eris\][\s\S]*$/, '') ||
    ''
  const needsTools = messageNeedsWorkspaceTools(originalUserGoal)
  try {
    await syncMcpRuntime(options.settings, workspacePath)
  } catch {
    // MCP optional
  }
  const checkpoint = createCheckpoint(workspacePath)
  pruneOldCheckpoints(workspacePath, 20)
  yield { type: 'checkpoint', checkpointId: checkpoint.id }

  // ——— Phase 1: Composer Lite — skipped when edits are needed and Full is ready ———
  // Loading Lite then Full thrash-unloads multi‑GB models and freezes the app.
  let goToWorker = needsTools && fullAvailable
  if (!goToWorker) {
    yield { type: 'model', model: liteModel }
    const liteMessages: AgentChatMessage[] = messages.map((m) => ({ ...m }))
    const firstSystem = liteMessages.findIndex((m) => m.role === 'system')
    const mcpNote = formatMcpServersPrompt(options.settings)
    // Keep Phase 1 prompt lean for the 4k Lite window.
    const liteSystem = [
      LITE_ORCHESTRATOR_PROMPT,
      `Workspace is open at: ${workspacePath}`,
      needsTools
        ? 'This request looks like it needs workspace edits — reply with CALL_FULL only.'
        : 'If this is just a question, answer it. If it needs file changes, reply CALL_FULL.',
      mcpNote ? mcpNote.slice(0, 400) : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    if (firstSystem >= 0) {
      const prior = liteMessages[firstSystem].content
      liteMessages[firstSystem] = {
        role: 'system',
        content: `${prior.slice(0, 3500)}\n\n${liteSystem}`.slice(0, 5000)
      }
    } else {
      liteMessages.unshift({ role: 'system', content: liteSystem })
    }

    yield { type: 'status', text: 'Composer Lite…' }
    let liteText = ''
    for await (const evt of streamThinkingText({
      ...options,
      model: liteModel,
      messages: liteMessages,
      stopOnToolCall: true
    })) {
      if (evt.kind === 'thinking') yield { type: 'thinking', text: evt.text }
      else liteText = evt.full
    }

    const callFull =
      needsTools || liteWantsFull(liteText) || looksLikeRefusal(liteText)

    if (!callFull) {
      const answer = stripToolBlocks(liteText) || liteText.trim()
      if (answer) yield { type: 'answer', text: answer }
      return
    }

    goToWorker = true
    if (!fullAvailable) {
      yield {
        type: 'thinking',
        text:
          '\n\n— Composer Full is not ready; Lite is attempting workspace tools. Download/verify Full in Settings → Models for reliable multi-file work.\n'
      }
    } else {
      yield {
        type: 'thinking',
        text: '\n\n— Handing off to Composer Full (worker)…\n'
      }
      yield { type: 'status', text: 'Composer Full working until done…' }
    }
  } else {
    yield {
      type: 'thinking',
      text: '\n\n— Workspace edits needed; starting Composer Full directly (skipping Lite load)…\n'
    }
    yield { type: 'status', text: 'Composer Full working until done…' }
  }

  if (!goToWorker) return

  // ——— Phase 2: Composer Full (or Lite fallback) ———
  const workerModel = fullAvailable ? toolModel : liteModel
  yield { type: 'model', model: workerModel }
  let retrievalHint = ''
  try {
    const retrieved = await retrieveContextAsync(workspacePath, originalUserGoal, 6)
    if (retrieved.paths.length > 0) {
      retrievalHint =
        `\n\n[Eris retrieval — likely relevant files]\n${retrieved.paths.map((p) => `- ${p}`).join('\n')}`
    }
  } catch {
    // optional
  }
  const mcpToolCount = listMcpTools().length
  const openaiTools: OpenAIToolDef[] = [
    ...COMPOSER_OPENAI_TOOLS,
    ...mcpToolsToOpenAI(
      listMcpTools().map((t) => ({
        fqName: t.fqName,
        description: t.description
      }))
    )
  ]
  const workerMessages: AgentChatMessage[] = [
    {
      role: 'system',
      content: buildWorkspaceToolsSystem(workspacePath, options.settings)
    },
    {
      role: 'user',
      content:
        `${originalUserGoal}${retrievalHint}\n\n` +
        `[Eris] You are Composer Full (the worker). Keep using tools until this request is fully done. ` +
        (mcpToolCount > 0 ? `MCP tools available (${mcpToolCount}). ` : '') +
        `First reply: emit ONLY a retrieve or tree tool JSON, then continue.`
    }
  ]

  let lastTreeResult: string | null = null
  let lastInspectResult: string | null = null
  let workspaceMutated = false
  /** True only when product source (not .eris skills/rules/context) changed. */
  let codeMutated = false
  const filesTouched: string[] = []
  const actionLog: string[] = []
  /** Rolling Lite-written memory folded across comped. */
  let contextMemory: string | null = null
  /** At most one dependency install per agent run. */
  let installAttempts = 0
  let noProgressStreak = 0
  let lastFingerprint = ''
  let repeatFingerprint = 0
  let toolExecRounds = 0
  let inspectRounds = 0
  let step = 0
  let verifyFailures = 0
  let mutationsSinceVerify = 0
  const reviewOnly = isReviewOnlyGoal(originalUserGoal)
  const promptBudget = contextBudgetTokens(options.settings, workerModel)

  async function* compactWorkerContext(opts: {
    force?: boolean
    skipLiteSummary?: boolean
  } = {}): AsyncGenerator<AgentRunnerEvent, void, unknown> {
    if (
      !needsContextCompaction(workerMessages, promptBudget, Boolean(opts.force))
    ) {
      return
    }
    // Never swap Lite↔Full mid-run — node-llama-cpp holds one runtime; unloading
    // Full to summarize with Lite freezes the app for minutes and looks "broken".
    const canSummarizeWithLite = liteModel === workerModel
    const skipLite = Boolean(opts.skipLiteSummary) || !canSummarizeWithLite
    yield { type: 'status', text: 'Compacting context…' }
    yield {
      type: 'thinking',
      text: skipLite
        ? '\n\n— Compacting context from action log…\n'
        : '\n\n— Summarizing context so work can continue…\n'
    }
    const compacted = await compactAgentMessages({
      messages: workerMessages,
      goal: originalUserGoal,
      filesTouched,
      actionLog,
      treeSnapshot: lastTreeResult,
      priorMemory: contextMemory,
      settings: options.settings,
      liteModel,
      temperature: options.temperature,
      signal: options.signal,
      getSecret: options.getSecret,
      skipLiteSummary: skipLite
    })
    workerMessages.length = 0
    workerMessages.push(...compacted.messages)
    contextMemory = compacted.memory || contextMemory
  }

  const nudgeToTools = (reason: string): AgentChatMessage => ({
    role: 'user',
    content:
      `${reason}\n` +
      (lastTreeResult
        ? `Tree already known — do NOT call tree/list_dir again.\nUser request:\n${originalUserGoal.slice(0, 1500)}\n\n` +
          (reviewOnly
            ? `Emit read_file or run (e.g. npm test) tool JSON, then a DONE summary when confirmed.`
            : `Emit write_file/mkdir/read_file tool JSON now. Do not stop until the request is fully done.`)
        : `Emit ONLY this JSON tool call:\n\n{"name":"tree","path":"."}\n\n` +
          `Then continue with read_file/run` +
          (reviewOnly ? '' : '/write_file') +
          ` until done.`)
  })

  const nudgeAfterInspect = (snapshot: string): AgentChatMessage => ({
    role: 'user',
    content:
      `TOOL_RESULT (listing already in context):\n${truncateForModel(snapshot, 4000)}\n\n` +
      `Do NOT call tree or list_dir again — you already have the listing.\n` +
      `User request:\n${originalUserGoal.slice(0, 1500)}\n\n` +
      (reviewOnly
        ? `Next: emit read_file on key source files and/or {"name":"run","command":"npm test"} (or typecheck). ` +
          `When you can confirm the app works, reply with a short DONE summary and no tools.`
        : `Emit write_file (and mkdir if needed) or read_file tool JSON now. Keep going until fully done; ` +
          `only then reply with a short DONE summary and no tools.`)
  })

  const nudgeContinueWork = (reason: string): AgentChatMessage => ({
    role: 'user',
    content:
      `${reason}\n` +
      `User request (still active):\n${originalUserGoal.slice(0, 1500)}\n` +
      (filesTouched.length
        ? `Already touched: ${[...new Set(filesTouched)].join(', ')}\n`
        : reviewOnly
          ? 'This is a review task — do not invent file edits.\n'
          : 'No files written yet.\n') +
      (reviewOnly
        ? `Emit read_file or run tool JSON, OR if you already confirmed the project, reply DONE summary with no tools.`
        : `You are NOT finished. Emit the next write_file/mkdir/read_file tool JSON now. ` +
          `When — and only when — the full request is satisfied, reply with a short DONE summary and no tools.`)
  })

  // Loop until done, abort, or hard budgets.
  for (;;) {
    throwIfAborted(options.signal)

    for await (const evt of compactWorkerContext()) yield evt

    step++
    if (step > MAX_AGENT_STEPS) {
      const note = buildWorkSummary(
        originalUserGoal,
        actionLog,
        `Stopped after ${MAX_AGENT_STEPS} steps (safety limit).`
      )
      yield {
        type: 'thinking',
        text: `\n\n— Stopped at step limit (${MAX_AGENT_STEPS}).\n`
      }
      yield { type: 'answer', text: note }
      return
    }
    yield {
      type: 'status',
      text: fullAvailable
        ? `Composer Full working (step ${step})…`
        : `Composer Lite tools (step ${step})…`
    }

    let assistantText = ''
    let abortedLoop = false
    let nativeFromStream: ToolCall[] | undefined
    for await (const evt of streamThinkingText({
      ...options,
      model: workerModel,
      messages: workerMessages,
      stopOnToolCall: true,
      tools: openaiTools
    })) {
      if (evt.kind === 'thinking') yield { type: 'thinking', text: evt.text }
      else {
        assistantText = evt.full
        abortedLoop = evt.aborted === 'loop'
        nativeFromStream = evt.nativeToolCalls
      }
    }
    throwIfAborted(options.signal)

    // Prefer native OpenAI tool_calls; fall back to text <<<TOOL>>> / JSON parsing.
    const toolCalls =
      nativeFromStream && nativeFromStream.length > 0
        ? nativeFromStream
        : parseToolCalls(assistantText)

    if (toolCalls.length === 0) {
      const keepGoing =
        shouldKeepWorking({
          needsTools: true,
          mutated: workspaceMutated,
          assistantText,
          reviewOnly,
          inspectRounds,
          actions: actionLog
        }) ||
        abortedLoop ||
        looksLikeDegenerateLoop(assistantText)

      if (keepGoing) {
        noProgressStreak++
        yield {
          type: 'thinking',
          text:
            noProgressStreak >= MAX_NO_PROGRESS
              ? '\n\n— Still not done; resetting context and continuing…\n'
              : '\n\n— Not done yet; Composer Full continuing…\n'
        }
        // Never stop — compact and keep pushing until finished.
        if (noProgressStreak >= MAX_NO_PROGRESS) {
          for await (const evt of compactWorkerContext({
            force: true,
            skipLiteSummary: true
          })) {
            yield evt
          }
          noProgressStreak = 0
        } else {
          workerMessages.push({ role: 'assistant', content: assistantText.slice(0, 1200) })
        }
        workerMessages.push(
          lastTreeResult
            ? nudgeContinueWork(
                abortedLoop || looksLikeDegenerateLoop(assistantText)
                  ? 'You got stuck or answered before finishing.'
                  : 'That reply did not finish the user request.'
              )
            : nudgeToTools('You must use tools to finish this request.')
        )
        continue
      }

      // Final verify only for product-code edits — skip skills/rules/context under .eris/
      if (workspaceMutated && !codeMutated) {
        yield {
          type: 'thinking',
          text: '\n\n— Skipping project verify (only .eris skills/config changed).\n'
        }
      }
      if (codeMutated) {
        yield { type: 'status', text: 'Final verify…' }
        const finalVerify = await runVerify(workspacePath, options.signal, {
          preferTypecheck: false,
          allowInstall: true
        })
        if (!finalVerify.skipped && !finalVerify.ok) {
          verifyFailures++
          yield { type: 'terminal', text: `$ ${finalVerify.command}\n${finalVerify.detail}\n` }
          if (verifyFailures >= MAX_VERIFY_FAILURES) {
            const workerNote = stripToolBlocks(assistantText).trim()
            const answer =
              buildWorkSummary(originalUserGoal, actionLog, workerNote) +
              `\n\nVerify still failing after ${verifyFailures} attempts:\n` +
              truncateForModel(finalVerify.detail, 1500)
            yield {
              type: 'thinking',
              text: '\n\n— Verify failed too many times; stopping with a summary.\n'
            }
            yield { type: 'answer', text: answer }
            return
          }
          yield {
            type: 'thinking',
            text: `\n\n— Verify still failing (${verifyFailures}/${MAX_VERIFY_FAILURES}); fixing…\n`
          }
          workerMessages.push({
            role: 'assistant',
            content: assistantText.slice(0, 800)
          })
          const missingDeps = looksLikeMissingDeps(finalVerify.detail)
          const installHint = missingDeps
            ? installAttempts >= MAX_BARE_INSTALLS_PER_RUN && hasNodeModules(workspacePath)
              ? ` Do NOT run bare npm install again — use npm install <package> for a missing dep, or fix imports.`
              : ` Missing modules: run npm install (or npm install <package>) in this workspace, then re-test.`
            : ` Do not run npm install for ordinary failures.`
          workerMessages.push({
            role: 'user',
            content:
              `VERIFY_RESULT (failed):\n${truncateForModel(finalVerify.detail, 8000)}\n\n` +
              `You are NOT done. Fix these errors with write_file/read_file tools now.` +
              installHint
          })
          continue
        }
      }

      // Deterministic summary — never unload Full to reload Lite just for a recap.
      const workerNote = stripToolBlocks(assistantText).trim()
      const answer = buildWorkSummary(originalUserGoal, actionLog, workerNote)
      yield { type: 'status', text: 'Done' }
      yield { type: 'answer', text: answer }
      return
    }

    const onlyInspect = toolCalls.every(
      (c) => c.name === 'tree' || c.name === 'list_dir' || c.name === 'retrieve'
    )
    const fp = toolFingerprint(toolCalls)
    if (fp === lastFingerprint) repeatFingerprint++
    else {
      lastFingerprint = fp
      repeatFingerprint = 0
    }

    // Only skip when the SAME inspect call is repeated — not every list_dir after tree.
    const repeatedInspect = onlyInspect && repeatFingerprint >= 1
    const inspectBudgetExceeded = onlyInspect && inspectRounds >= 3

    if (repeatedInspect || inspectBudgetExceeded) {
      noProgressStreak++
      yield {
        type: 'thinking',
        text: repeatedInspect
          ? '\n\n— Same listing repeated; moving on…\n'
          : '\n\n— Enough directory listings; read files or finish…\n'
      }
      const snapshot = lastInspectResult || lastTreeResult || '(listing already returned earlier)'
      workerMessages.push({ role: 'assistant', content: assistantText.slice(0, 800) })
      // After two skip cycles on review tasks, allow DONE without more tools
      if (reviewOnly && noProgressStreak >= 2) {
        workerMessages.push({
          role: 'user',
          content:
            `TOOL_RESULT (cached):\n${truncateForModel(snapshot, 3000)}\n\n` +
            `Stop calling tree/list_dir. Either emit ONE read_file or run tool, ` +
            `OR reply with a DONE summary of whether the calculator app looks working — no tools.`
        })
      } else {
        workerMessages.push(
          noProgressStreak >= MAX_NO_PROGRESS
            ? nudgeContinueWork(
                reviewOnly
                  ? 'Stop listing directories. Read a source file, run tests, or DONE.'
                  : 'Stop inspecting. Finish the remaining file edits now.'
              )
            : nudgeAfterInspect(snapshot)
        )
      }
      if (noProgressStreak >= MAX_NO_PROGRESS) {
        for await (const evt of compactWorkerContext({
          force: true,
          skipLiteSummary: true
        })) {
          yield evt
        }
        noProgressStreak = 0
      }
      continue
    }

    if (repeatFingerprint >= 4 && !onlyInspect) {
      noProgressStreak++
      yield {
        type: 'thinking',
        text: '\n\n— Same tool call repeated; moving on to the next unfinished edit…\n'
      }
      workerMessages.push({ role: 'assistant', content: assistantText.slice(0, 800) })
      workerMessages.push(
        nudgeContinueWork(
          'You repeated the same tool call. Move on to the next unfinished part of the request.'
        )
      )
      repeatFingerprint = 0
      if (noProgressStreak >= MAX_NO_PROGRESS) {
        for await (const evt of compactWorkerContext({
          force: true,
          skipLiteSummary: true
        })) {
          yield evt
        }
        noProgressStreak = 0
      }
      continue
    }

    toolExecRounds++
    yield {
      type: 'thinking',
      text: `\n\n— Running ${toolCalls.length} workspace tool${toolCalls.length === 1 ? '' : 's'}…\n`
    }

    workerMessages.push({ role: 'assistant', content: assistantText })

    const resultParts: string[] = []
    let mutatedThisRound = false
    let codeMutatedThisRound = false
    for (let i = 0; i < toolCalls.length; i++) {
      throwIfAborted(options.signal)
      const call = toolCalls[i]
      const id = `t${toolExecRounds}_${i}`
      const path =
        typeof call.args.path === 'string'
          ? call.args.path
          : typeof call.args.to === 'string'
            ? call.args.to
            : typeof call.args.command === 'string'
              ? call.args.command.slice(0, 80)
              : undefined
      yield {
        type: 'tool',
        tool: { id, name: call.name, path, status: 'running', detail: 'Running…' }
      }

      let result: { ok: boolean; detail: string; mutated: boolean; path?: string }

      if (call.name === 'run') {
        const command = argString(call.args, 'command')
        if (!command) {
          result = { ok: false, detail: 'command is required', mutated: false }
        } else if (isGlobalInstallCommand(command)) {
          result = {
            ok: false,
            detail:
              'Blocked: global installs are not allowed. Install into this workspace instead ' +
              '(e.g. `npm install <pkg>`, `npm install`, or a project venv — never `npm -g`).',
            mutated: false
          }
          yield {
            type: 'thinking',
            text: '\n\n— Blocked global install (workspace must stay self-contained).\n'
          }
        } else if (isInstallCommand(command)) {
          const addingPackage = isPackageAddInstall(command)
          const modulesPresent = hasNodeModules(workspacePath)
          const pkgNewer = packageJsonNewerThanModules(workspacePath)
          // Allow workspace installs freely; only stop bare reinstall loops.
          const needsInstall = !modulesPresent || pkgNewer
          const blockBareLoop =
            !addingPackage &&
            !needsInstall &&
            installAttempts >= MAX_BARE_INSTALLS_PER_RUN

          if (blockBareLoop) {
            result = {
              ok: false,
              detail:
                `Blocked: bare install already ran ${MAX_BARE_INSTALLS_PER_RUN} times this session. ` +
                'Use `npm install <package>` to add a dependency, or fix code/tests — do not loop install.',
              mutated: false
            }
            yield {
              type: 'thinking',
              text: '\n\n— Skipped repeat bare install (anti-loop).\n'
            }
          } else {
            if (!addingPackage) installAttempts++
            yield { type: 'terminal', text: `$ ${command}\n` }
            yield {
              type: 'thinking',
              text: addingPackage
                ? '\n\n— Installing package into workspace…\n'
                : pkgNewer
                  ? '\n\n— package.json changed; refreshing workspace dependencies…\n'
                  : '\n\n— Installing workspace dependencies…\n'
            }
            const ran = await runWorkspaceCommand(workspacePath, command, {
              signal: options.signal,
              timeoutMs: 300_000
            })
            const out = [ran.stdout, ran.stderr].filter(Boolean).join('\n')
            if (out) yield { type: 'terminal', text: `${out}\n` }
            result = {
              ok: ran.ok,
              detail: ran.timedOut
                ? `Timed out.\n${out}\n\nDo not re-run install in a loop. Try the test/build command next.`
                : `exit ${ran.code ?? '?'}\n${out || '(no output)'}\n\n` +
                  (ran.ok
                    ? 'Install finished into this workspace (node_modules/.bin on PATH). Next: test/typecheck/build.'
                    : 'Install failed. Inspect the error or fix package.json; do not loop install.'),
              mutated: false
            }
          }
        } else {
          yield { type: 'terminal', text: `$ ${command}\n` }
          const ran = await runWorkspaceCommand(workspacePath, command, {
            signal: options.signal
          })
          const out = [ran.stdout, ran.stderr].filter(Boolean).join('\n')
          if (out) yield { type: 'terminal', text: `${out}\n` }
          result = {
            ok: ran.ok,
            detail: ran.timedOut
              ? `Timed out.\n${out}`
              : `exit ${ran.code ?? '?'}\n${out || '(no output)'}`,
            mutated: false
          }
        }
      } else if (call.name === 'grep') {
        const pattern = argString(call.args, 'pattern') || argString(call.args, 'query')
        const glob = argString(call.args, 'glob') || undefined
        const grepped = await workspaceGrep(workspacePath, pattern, { glob })
        result = { ok: grepped.ok, detail: grepped.detail, mutated: false }
      } else if (call.name === 'glob') {
        const pattern = argString(call.args, 'pattern') || '**/*'
        const globbed = workspaceGlob(workspacePath, pattern)
        result = { ok: globbed.ok, detail: globbed.detail, mutated: false }
      } else if (call.name === 'search_symbols') {
        const query = argString(call.args, 'query') || argString(call.args, 'pattern')
        const found = findSymbols(workspacePath, query)
        result = { ok: found.ok, detail: found.detail, mutated: false }
      } else if (call.name === 'retrieve') {
        const query =
          argString(call.args, 'query') || argString(call.args, 'pattern') || originalUserGoal
        const retrieved = await retrieveContextAsync(workspacePath, query, 8)
        result = { ok: retrieved.ok, detail: retrieved.detail, mutated: false }
      } else if (call.name === 'read_context') {
        const prompt = formatWorkspaceContextPrompt(workspacePath, { full: true })
        const doc = getWorkspaceContext(workspacePath)
        result = {
          ok: true,
          detail:
            prompt ||
            '(empty — edit .eris/context.md or use update_context to save workspace facts)',
          path: '.eris/context.md',
          mutated: false
        }
        if (doc.pin) {
          result.detail = `${prompt}\n\n[pin length ${doc.pin.length} chars]`
        }
      } else if (call.name === 'read_email') {
        const email = readPulledEmailContext(workspacePath)
        result = {
          ok: email.ok,
          detail: email.detail,
          path: email.path,
          mutated: false
        }
      } else if (call.name === 'list_skills') {
        result = {
          ok: true,
          detail: formatSkillsListForAgent(workspacePath),
          path: userSkillsDir(),
          mutated: false
        }
      } else if (call.name === 'read_skill') {
        const idRaw =
          argString(call.args, 'id') ||
          argString(call.args, 'skill_id') ||
          argString(call.args, 'name')
        const id = idRaw ? slugifySkillId(idRaw) : ''
        const scopeRaw = (argString(call.args, 'scope') || '').toLowerCase()
        const scope =
          scopeRaw === 'workspace' || scopeRaw === 'user'
            ? (scopeRaw as 'user' | 'workspace')
            : undefined
        const skill = id ? getSkill(workspacePath, id, scope) : null
        result = skill
          ? {
              ok: true,
              detail:
                `id: ${skill.id}\nscope: ${skill.scope}\nname: ${skill.name}\n` +
                `description: ${skill.description}\npath: ${skill.path}\n\n${skill.body}`,
              path: skill.path,
              mutated: false
            }
          : {
              ok: false,
              detail: id
                ? `Skill “${id}” not found${scope ? ` in ${scope} scope` : ''}`
                : 'read_skill requires id',
              mutated: false
            }
      } else if (call.name === 'write_skill') {
        const skillName =
          argString(call.args, 'skill_name') ||
          argString(call.args, 'name') ||
          argString(call.args, 'title')
        const description =
          argString(call.args, 'description') || argString(call.args, 'desc') || ''
        const body =
          argString(call.args, 'body') ||
          argString(call.args, 'content') ||
          argString(call.args, 'instructions')
        const idArg =
          argString(call.args, 'id') || argString(call.args, 'skill_id') || skillName
        const scopeRaw = (argString(call.args, 'scope') || 'user').toLowerCase()
        const scope = scopeRaw === 'workspace' ? 'workspace' : 'user'
        if (!skillName.trim() || !body.trim()) {
          result = {
            ok: false,
            detail: 'write_skill requires skill_name and body (markdown instructions)',
            mutated: false
          }
        } else {
          try {
            const skill = upsertSkill(workspacePath, {
              id: idArg,
              name: skillName,
              description,
              body,
              scope
            })
            result = {
              ok: true,
              detail:
                `Saved ${skill.scope} skill “${skill.name}” (${skill.id})\n` +
                `path: ${skill.path}\n` +
                (skill.scope === 'user'
                  ? 'Stored outside the project (user skills folder).'
                  : 'Stored in this project under .eris/skills/.'),
              path: skill.path,
              // Skill files are not product code — never trigger npm/test verify.
              mutated: false
            }
            yield { type: 'workspace-changed' }
          } catch (err) {
            result = {
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
              mutated: false
            }
          }
        }
      } else if (call.name === 'update_context') {
        const text =
          argString(call.args, 'text') ||
          argString(call.args, 'content') ||
          argString(call.args, 'note')
        const mode = (argString(call.args, 'mode') || 'append').toLowerCase()
        if (!text.trim()) {
          result = { ok: false, detail: 'update_context requires text', mutated: false }
        } else if (mode === 'summary' || mode === 'set_summary') {
          const doc = setContextSummary(workspacePath, text)
          result = {
            ok: true,
            detail: `Updated pinned Summary (${doc.pin.length} chars).\nPin:\n${doc.pin}`,
            path: '.eris/context.md',
            // Not a source-tree mutation — skip verify/diff pipeline.
            mutated: false
          }
        } else {
          const doc = appendContextNote(workspacePath, text)
          result = {
            ok: true,
            detail: `Appended note to .eris/context.md.\nPin:\n${doc.pin || '(no summary yet)'}`,
            path: '.eris/context.md',
            mutated: false
          }
        }
      } else if (isMcpToolName(call.name)) {
        const mcpResult = await callMcpTool(call.name, call.args)
        result = { ok: mcpResult.ok, detail: mcpResult.detail, mutated: false }
      } else if (
        call.name === 'write_file' ||
        call.name === 'search_replace' ||
        call.name === 'apply_patch'
      ) {
        const writePath =
          call.name === 'apply_patch'
            ? '' // resolved inside tool
            : argString(call.args, 'path')
        let before: string | null = writePath
          ? snapshotBeforeWrite(workspacePath, checkpoint.id, writePath)
          : null
        let afterContent: string | null =
          call.name === 'write_file' && typeof call.args.content === 'string'
            ? call.args.content
            : null
        if (call.name === 'search_replace' && writePath) {
          try {
            const oldString = argString(call.args, 'old_string') || argString(call.args, 'oldString')
            const newString =
              typeof call.args.new_string === 'string'
                ? call.args.new_string
                : typeof call.args.newString === 'string'
                  ? call.args.newString
                  : ''
            const replaceAll = Boolean(call.args.replace_all ?? call.args.replaceAll)
            const edited = searchReplaceInFile(
              workspacePath,
              writePath,
              oldString,
              newString,
              replaceAll
            )
            before = edited.before
            afterContent = edited.after
            result = {
              ok: true,
              detail: `Replaced ${edited.replacements} occurrence(s) in ${edited.path}`,
              mutated: true,
              path: edited.path
            }
          } catch (err) {
            result = {
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
              mutated: false,
              path: writePath || undefined
            }
          }
        } else if (call.name === 'apply_patch') {
          try {
            const patch = argString(call.args, 'patch') || argString(call.args, 'diff')
            const edited = applyUnifiedPatch(workspacePath, patch)
            before = edited.before
            afterContent = edited.after
            result = {
              ok: true,
              detail: `Applied patch to ${edited.path}`,
              mutated: true,
              path: edited.path
            }
          } catch (err) {
            result = {
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
              mutated: false
            }
          }
        } else {
          result = executeTool(workspacePath, call)
        }
        if (result.ok && result.path && afterContent != null) {
          const rec = recordWriteOp(
            workspacePath,
            checkpoint.id,
            result.path,
            before,
            afterContent
          )
          const opIndex = rec ? rec.ops.length - 1 : 0
          invalidateDiagnosticsCache()
          yield {
            type: 'diff',
            diff: {
              checkpointId: checkpoint.id,
              opIndex,
              path: result.path,
              before,
              after: afterContent,
              op: 'write'
            }
          }
        }
      } else if (call.name === 'git_status') {
        const st = await gitStatus(workspacePath)
        if (!st.ok) {
          result = { ok: false, detail: st.error || 'git status failed', mutated: false }
        } else {
          const lines = [
            `branch ${st.branch || '?'} ↑${st.ahead} ↓${st.behind}`,
            ...st.entries.map((e) => `${e.status} ${e.path}`)
          ]
          result = {
            ok: true,
            detail: lines.join('\n') || 'clean',
            mutated: false
          }
        }
      } else if (call.name === 'git_diff') {
        const path = argString(call.args, 'path') || undefined
        const d = await gitDiff(workspacePath, path)
        result = {
          ok: d.ok,
          detail: d.ok ? d.diff : d.error || 'git diff failed',
          mutated: false,
          path
        }
      } else if (call.name === 'git_stage') {
        const paths = Array.isArray(call.args.paths)
          ? call.args.paths.map(String)
          : argString(call.args, 'path')
            ? [argString(call.args, 'path')]
            : []
        const staged = await gitStage(workspacePath, paths)
        result = {
          ok: staged.ok,
          detail: staged.ok ? `Staged ${paths.join(', ')}` : staged.error || 'stage failed',
          mutated: false
        }
      } else if (call.name === 'git_commit') {
        const message = argString(call.args, 'message')
        const committed = await gitCommit(workspacePath, message)
        result = {
          ok: committed.ok,
          detail: committed.ok ? `Committed: ${message}` : committed.error || 'commit failed',
          mutated: committed.ok
        }
      } else if (call.name === 'git_stash') {
        const action = (argString(call.args, 'action', 'push') || 'push') as
          | 'push'
          | 'pop'
          | 'list'
        const message = argString(call.args, 'message') || undefined
        const stashed = await gitStash(workspacePath, action, message)
        result = {
          ok: stashed.ok,
          detail: stashed.ok
            ? stashed.output || `stash ${action} ok`
            : stashed.error || 'stash failed',
          mutated: action !== 'list' && stashed.ok
        }
      } else if (call.name === 'git_sync') {
        const action = (argString(call.args, 'action', 'pull') || 'pull') as
          | 'fetch'
          | 'pull'
          | 'push'
        const settings = options.settings
        const remoteName = settings?.github?.remoteName || 'origin'
        const branch = (await gitStatus(workspacePath)).branch
        const tokenRef = settings?.github?.tokenRef
        const token = tokenRef ? options.getSecret(tokenRef) : null
        const ref = settings?.github?.repository
          ? parseGithubRepo(settings.github.repository, settings.github.host || 'github.com')
          : null
        const synced = await pushPullFetch(
          workspacePath,
          action,
          remoteName,
          branch,
          token,
          ref,
          settings?.github?.preferredProtocol || 'https'
        )
        result = {
          ok: synced.ok,
          detail: synced.ok
            ? synced.output || `${action} ok`
            : synced.error || `${action} failed`,
          mutated: false
        }
      } else if (call.name === 'delete_path') {
        const delPath = argString(call.args, 'path')
        let before = ''
        let wasDirectory = false
        if (delPath) {
          try {
            const abs = resolveInWorkspace(workspacePath, delPath)
            if (existsSync(abs)) {
              wasDirectory = statSync(abs).isDirectory()
              if (!wasDirectory) before = readFileSync(abs, 'utf8')
            }
          } catch {
            // ignore
          }
        }
        result = executeTool(workspacePath, call)
        if (result.ok && delPath) {
          const rec = recordDeleteOp(workspacePath, checkpoint.id, delPath, before, wasDirectory)
          const opIndex = rec ? rec.ops.length - 1 : 0
          yield {
            type: 'diff',
            diff: {
              checkpointId: checkpoint.id,
              opIndex,
              path: result.path ?? delPath,
              before,
              after: '',
              op: 'delete'
            }
          }
        }
      } else if (call.name === 'rename_path') {
        const from = argString(call.args, 'path')
        const to = argString(call.args, 'to')
        const before = from ? snapshotBeforeWrite(workspacePath, checkpoint.id, from) : null
        result = executeTool(workspacePath, call)
        if (result.ok && from && to) {
          const rec = recordRenameOp(workspacePath, checkpoint.id, from, to, before)
          const opIndex = rec ? rec.ops.length - 1 : 0
          yield {
            type: 'diff',
            diff: {
              checkpointId: checkpoint.id,
              opIndex,
              path: `${from} → ${to}`,
              before,
              after: before ?? '',
              op: 'rename'
            }
          }
        }
      } else if (call.name === 'mkdir') {
        const mkdirPath = argString(call.args, 'path')
        result = executeTool(workspacePath, call)
        if (result.ok && mkdirPath) {
          const rec = recordMkdirOp(workspacePath, checkpoint.id, mkdirPath)
          const opIndex = rec ? rec.ops.length - 1 : 0
          yield {
            type: 'diff',
            diff: {
              checkpointId: checkpoint.id,
              opIndex,
              path: result.path ?? mkdirPath,
              before: null,
              after: '',
              op: 'mkdir'
            }
          }
        }
      } else {
        result = executeTool(workspacePath, call)
      }

      if (result.mutated) {
        mutatedThisRound = true
        workspaceMutated = true
        if (result.path) filesTouched.push(result.path)
        if (pathNeedsProjectVerify(result.path)) {
          codeMutated = true
          codeMutatedThisRound = true
        }
      }
      if (result.ok) {
        if (call.name === 'tree') {
          lastTreeResult = result.detail
          lastInspectResult = result.detail
        } else if (call.name === 'list_dir' || call.name === 'retrieve') {
          lastInspectResult = result.detail
          if (!lastTreeResult) lastTreeResult = result.detail
        }
        const label =
          call.name === 'write_file' ||
          call.name === 'search_replace' ||
          call.name === 'apply_patch' ||
          call.name === 'mkdir' ||
          call.name === 'delete_path' ||
          call.name === 'rename_path' ||
          call.name === 'run' ||
          call.name.startsWith('git_')
            ? result.detail.split('\n')[0]!.slice(0, 160)
            : call.name === 'read_file'
              ? `Read ${result.path ?? path ?? 'file'}`
              : call.name === 'tree' || call.name === 'list_dir'
                ? `Inspected ${result.path ?? path ?? '.'}`
                : call.name === 'verify'
                  ? `Verify ${result.ok ? 'ok' : 'fail'}`
                  : result.detail.slice(0, 120)
        actionLog.push(label)
      } else {
        actionLog.push(`Failed ${call.name}${path ? ` ${path}` : ''}: ${result.detail.slice(0, 80)}`)
      }
      yield {
        type: 'tool',
        tool: {
          id,
          name: call.name,
          path: result.path ?? path,
          status: result.ok ? 'ok' : 'error',
          detail: result.detail.slice(0, 2000)
        }
      }
      yield {
        type: 'thinking',
        text: `\n[${result.ok ? 'ok' : 'error'}] ${call.name}${
          result.path ? ` ${result.path}` : ''
        }: ${result.detail.slice(0, 240)}\n`
      }
      resultParts.push(
        `TOOL_RESULT ${call.name}${result.path ? ` path=${result.path}` : ''}:\n${truncateForModel(result.detail)}`
      )
    }
    if (onlyInspect) inspectRounds++

    if (mutatedThisRound) {
      noProgressStreak = 0
      yield { type: 'workspace-changed' }
    } else if (!onlyInspect) {
      noProgressStreak++
    }

    // Verify periodically (not after every write) to avoid thrashing tsc/tests.
    // Never verify for .eris-only rounds (skills, rules, context).
    let verifyNote = ''
    if (codeMutatedThisRound) {
      mutationsSinceVerify++
      const shouldVerify =
        mutationsSinceVerify >= VERIFY_EVERY_N_MUTATIONS &&
        verifyFailures < MAX_VERIFY_FAILURES
      if (shouldVerify) {
        mutationsSinceVerify = 0
        yield { type: 'status', text: 'Verifying (typecheck/tests)…' }
        yield { type: 'thinking', text: '\n\n— Running verify (typecheck/tests)…\n' }
        // Mid-loop: typecheck-first, never npm install (keeps agent moving).
        const verified = await runVerify(workspacePath, options.signal, {
          preferTypecheck: true,
          allowInstall: false
        })
        throwIfAborted(options.signal)
        if (!verified.skipped) {
          yield { type: 'terminal', text: `$ ${verified.command}\n${verified.detail}\n` }
          yield {
            type: 'tool',
            tool: {
              id: `verify_${toolExecRounds}`,
              name: 'verify',
              status: verified.ok ? 'ok' : 'error',
              detail: verified.detail.slice(0, 2000)
            }
          }
          verifyNote = `\n\nVERIFY_RESULT (${verified.ok ? 'passed' : 'failed'}):\n${truncateForModel(verified.detail, 8000)}\n`
          if (!verified.ok) {
            verifyFailures++
            const missingDeps = looksLikeMissingDeps(verified.detail)
            verifyNote +=
              `Verify failed (${verifyFailures}/${MAX_VERIFY_FAILURES}). Fix with write_file/read_file.\n`
            if (missingDeps) {
              if (installAttempts >= MAX_BARE_INSTALLS_PER_RUN && hasNodeModules(workspacePath)) {
                verifyNote +=
                  `Missing-module errors: prefer npm install <package> or fix imports — avoid bare install loops.\n`
              } else {
                verifyNote +=
                  `Missing-module errors: run npm install (or npm install <package>) in this workspace, then re-test.\n`
              }
            } else {
              verifyNote += `Do not run npm install for ordinary test/typecheck failures.\n`
            }
            actionLog.push(`Verify failed: ${verified.command}`)
            if (verifyFailures >= MAX_VERIFY_FAILURES) {
              const answer =
                buildWorkSummary(originalUserGoal, actionLog, '') +
                `\n\nStopped: verify failed ${verifyFailures} times.\n` +
                truncateForModel(verified.detail, 1500)
              yield {
                type: 'thinking',
                text: '\n\n— Verify failure budget exhausted; stopping.\n'
              }
              yield { type: 'answer', text: answer }
              return
            }
          } else {
            verifyFailures = 0
            actionLog.push(`Verify passed: ${verified.command}`)
          }
        }
      }
    }

    if (onlyInspect) {
      const snap = lastInspectResult || lastTreeResult || resultParts.join('\n\n')
      workerMessages.push(nudgeAfterInspect(snap))
    } else {
      const progress =
        filesTouched.length > 0
          ? `Files touched so far: ${[...new Set(filesTouched)].join(', ')}.\n`
          : ''
      workerMessages.push({
        role: 'user',
        content:
          `${resultParts.join('\n\n')}${verifyNote}\n\n${progress}` +
          (reviewOnly
            ? `If you still need evidence, emit read_file or run. ` +
              `If you can already confirm the review, reply with a DONE summary and no tools. ` +
              `Do not call tree/list_dir again.`
            : `If the user request is NOT fully done` +
              (verifyNote.includes('failed') ? ' or verify failed' : '') +
              `, emit the next write_file/mkdir/read_file tool JSON now. ` +
              `If it IS fully done` +
              (verifyNote && !verifyNote.includes('failed') ? ' and verify passed' : '') +
              `, reply with a short DONE summary and no tools. ` +
              `Do not call tree again unless the user asks for another listing.`)
      })
    }
  }
}
