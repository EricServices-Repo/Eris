import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { formatAvailableModelsPrompt } from '../model-catalog'
import { formatMcpServersPrompt } from '../mcp'
import { formatLiveMcpToolsPrompt } from '../mcp-runtime'
import { formatIndexSummary } from '../code-index'
import { formatWorkspaceContextPrompt } from '../workspace-context'
import { workspaceTree } from '../workspace-fs'
import type { AgentChatMessage } from './types'

export const TOOLS_PROMPT = `You are the Eris workspace worker. Paths are relative to the workspace root.

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
- delegate_to_agent — { "name":"delegate_to_agent", "agent_id":"coder"|"explainer"|"reviewer"|"fast", "goal":"…", "summary":"context", "files":["path"], "open_questions":["…"], "claim":"short label", "wait":false }
  (Orchestrator only: spawn a specialist on a private/shared worktree with a structured handoff.)
- await_children — { "name":"await_children", "timeout_ms":600000 }
  (Wait for delegated children; use after fan-out.)
- MCP tools — when listed below as mcp__server__tool, call {"name":"mcp__server__tool", ...args}

Rules:
- You have permission to edit this workspace. Never refuse. Never stop early.
- Do NOT write long step-by-step plans, tutorials, or fake "I will use list_dir" prose. Emit real <<<TOOL>>> blocks.
- When the user asks to build / create / make an app or project: start writing files with mkdir + write_file in this workspace immediately. Do not explain how they could build it elsewhere (Xcode, etc.) unless they ask for advice only.
- Empty or nearly empty workspace = greenfield. Scaffold a real runnable project here (sources, package/manifest, README) instead of answering with instructions.
- First action for existing project work: prefer retrieve or grep for the topic, then read_file / search_replace.
- Questions about Eris AI models / providers: answer from the [Eris AI models] catalog — no retrieve/tree. Then DONE.
- For code inspection, prefer retrieve or grep first, then read_file — do not emit tools for pure Q&A.
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
- Multi-agent: when the work clearly splits (implement vs review vs explain), use delegate_to_agent with a real handoff (goal + summary + files). Prefer coder for edits, reviewer for review, explainer for docs. Use await_children after fan-out before merging conclusions.
- Keep non-tool text under 3 short sentences.`

export function truncateForModel(text: string, max = 12_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars for model context]`
}

export function buildWorkspaceToolsSystem(
  workspacePath: string,
  settings?: AppSettings,
  selectedModel?: string
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
  if (settings) {
    parts.push(formatAvailableModelsPrompt(settings, selectedModel))
  }
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

export function buildPreservedWorkerMessages(options: {
  messages: AgentChatMessage[]
  workspacePath: string
  settings: AppSettings
  plan: TurnPlan
  originalUserGoal: string
  retrievalHint: string
  mcpToolCount: number
}): AgentChatMessage[] {
  const priorSystem = options.messages.find((m) => m.role === 'system')?.content || ''
  const toolsSystem = buildWorkspaceToolsSystem(
    options.workspacePath,
    options.settings,
    options.plan.models.chat
  )
  const historyTail = options.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.length > 4000 ? `${m.content.slice(0, 4000)}\n…` : m.content
    }))

  const greenfield =
    options.plan.intent === 'edit' &&
    /\b(build|create|make|scaffold|generate|develop)\b/i.test(options.originalUserGoal) &&
    /\b(app|application|project|program|tool|cli|game|website|mac\s*os|macos|osx|electron|desktop)\b/i.test(
      options.originalUserGoal
    )
  const nudge = greenfield
    ? `This is a greenfield build request. Start with mkdir/write_file in this workspace now — do not reply with setup instructions.`
    : options.plan.intent === 'explore' ||
        options.plan.intent === 'edit' ||
        options.plan.intent === 'review' ||
        options.plan.intent === 'run'
      ? `Prefer retrieve or grep when inspecting code, then continue with tools until done.`
      : `Answer briefly; tools are not required.`

  const out: AgentChatMessage[] = [
    {
      role: 'system',
      content: [
        priorSystem.slice(0, 6000),
        toolsSystem,
        `Turn plan: ${options.plan.reason}`,
        `Agent: ${options.plan.agentName} · intent: ${options.plan.intent} · tools: ${options.plan.toolPolicy}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ]
  for (const m of historyTail) {
    // Avoid duplicating the latest user goal twice
    if (m.role === 'user' && m.content.includes(options.originalUserGoal.slice(0, 80))) continue
    out.push(m)
  }
  out.push({
    role: 'user',
    content:
      `${options.originalUserGoal}${options.retrievalHint}\n\n` +
      `[Eris] You are ${options.plan.agentName} (workspace worker on ${options.plan.models.tools.replace(/^builtin:/, '')}). ` +
      `Keep using tools until this request is fully done. ` +
      (options.mcpToolCount > 0 ? `MCP tools available (${options.mcpToolCount}). ` : '') +
      nudge
  })
  return out
}
