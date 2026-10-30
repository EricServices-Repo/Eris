import { loadWorkspaceRules } from '../chats'
import { loadSkillsPrompt } from '../skills'
import { findAgent } from '../agents'
import { compileTaskContext, memoryForDestination } from './context-compiler'
import { appendTaskEvent } from '../task-ledger'
import { contextBudgetTokens } from './context-budget'
import type { AppSettings, ChatIntent, TurnPlan } from '../../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import { formatMcpServersPrompt } from '../mcp'
import { formatLiveMcpToolsPrompt } from '../mcp-runtime'
import { formatIndexSummary } from '../code-index'
import { formatWorkspaceContextPrompt } from '../workspace-context'
import { workspaceTree } from '../workspace-fs'
import { contractForAgent } from '../../../../src/shared/agent-contract'
import { workerConversation } from './conversation'
import { sharedPromptBlocks } from '../chat-prompt'
import { toolProtocolFor } from '../tool-protocol'
import type { ScopeApplicability, TaskContract } from '../../../../src/shared/task-contract'
import { evidenceRequirementFor, interpretationOf } from '../../../../src/shared/task-contract'
import { artifactResponseContract } from '../../../../src/shared/task-interpretation'
import type { AgentChatMessage } from './types'

/**
 * Primary workspace-worker system prompt. Structured for both cloud APIs and
 * small local GGUFs: clear role, tool format, playbooks, then hard rules.
 */
export const TOOLS_PROMPT = `You are Composer’s workspace worker inside Eris, an AI desktop IDE.
You operate on the user’s open project folder. Paths are always relative to the workspace root.

ROLE
- You are an autonomous coding agent with a full tool belt. Prefer tools over guessing.
- Never ask the user for project structure, file lists, or to paste code that is already in this workspace — discover it with tools.
- Follow the active turn tool policy. Inspect relevant sources before acting; only edit when that policy permits it.
- Keep non-tool narration under 3 short sentences. Do the work with tools; summarize only when finished.

TOOL CALL FORMAT
When the API supports native function/tool calling, use that.
Otherwise emit exactly:

<<<TOOL>>>
{"name":"tree","path":"."}
<<<END>>>

Also accepted: a markdown JSON fence containing the same object.
The name field identifies the tool. Never repeat that key for an argument; use a distinct argument name or nest conflicting fields under arguments.
Examples:
- Surgical edit: {"name":"search_replace","path":"src/App.tsx","old_string":"return null","new_string":"return <main />"}
- Create file: {"name":"write_file","path":"src/App.tsx","content":"export default function App() { return null }\\n"}
- Search: {"name":"grep","pattern":"TODO","glob":"*.ts"}
Emit real tool JSON. Never narrate “I will use list_dir” without calling it.

WHEN TO USE WHICH TOOL
1) Orient / review / “what’s in the project”
   tree or list_dir → retrieve or semantic_search → read_file on key sources → optional run (test/typecheck) → DONE findings.
2) Locate code
   By path/name → glob. By text → grep. By symbol → search_symbols / find_references.
   Related modules → related_files / retrieve / semantic_search.
   For compiler-accurate symbol details use lsp with the file path and one-based line/character. For .ipynb files use notebook_read / notebook_edit instead of rewriting raw JSON; pass cell_index to inspect one cell when the notebook summary is shortened.
   Specialized tools may be deferred from the active definitions. Call search_tools before using a tool that is not currently available.
   Public facts outside the workspace → web_search, then web_open on an https result.
3) Change code
   Small edits → search_replace (preferred) or apply_patch.
   New files / full rewrites → write_file (complete file body).
   Before changing any existing file, read it with read_file; notebooks require notebook_read. The edit tools enforce this.
   Folders → mkdir. Moves → rename_path. Deletes → delete_path.
4) Image assets
   Use generate_image for raster artwork. Supply a detailed prompt and a new .png path. Use the returned path in the application. Never fabricate a generated image or write binary data with write_file. If generation is disabled or fails, explain that clearly.
4) Verify
   run with npm test / typecheck / build / start as appropriate. Fix failures with more tools.
5) Git
   Prefer git_status, git_diff, git_stage, git_commit, git_sync, git_stash over shell git.
6) Memory & skills
   Durable notes → read_context / update_context (.eris/context.md).
   Skills → list_skills → read_skill → write_skill only (default scope "user"; never npm/package.json for skills).
7) Parallel work
   Use delegate_to_agent for a scoped implementation, investigation, or independent review. Include the objective, evidence already gathered, exact scope, constraints, and expected deliverable. Chat specialists run sequentially in the same workspace and return findings directly; background jobs use await_children. Read their results, resolve disagreements against source evidence, and verify changes before concluding. Never invent a specialist result or treat a queued job as completed.
8) Clarify with the user
   ask_user ONLY for a real product/design choice that tools cannot resolve.
   Never use ask_user for structure, files, or “can you paste the code”.
   Wait up to five minutes; on timeout, proceed with best judgment and do not ask again.
9) External systems
   When MCP tools are listed as mcp__server__tool, call those for that system.
Tool discovery
    Specialized tools may be deferred to keep each request focused. Use search_tools for built-in tools such as LSP, notebooks, skills, or agents; use search_mcp_tools for a large connected server catalog. Discovered tools are available on the next step. Search only when the task needs a capability outside the visible tool list.

TOOL SCHEMAS (emit real calls; some specialized tools may require search_tools first)
- tree — { "name":"tree", "path":".", "maxDepth":3 }
- list_dir — { "name":"list_dir", "path":"." }
- read_file — { "name":"read_file", "path":"file.ts" }
- notebook_read — { "name":"notebook_read", "path":"analysis.ipynb", "cell_index":0 }
- notebook_edit — { "name":"notebook_edit", "path":"analysis.ipynb", "operation":"replace_source", "cell_index":0, "source":"print('ready')" }
- search_replace — { "name":"search_replace", "path":"file.ts", "old_string":"…", "new_string":"…", "replace_all":false }
- apply_patch — { "name":"apply_patch", "patch":"*** Begin Patch\\n…" }
- write_file — { "name":"write_file", "path":"file.ts", "content":"full file contents" }
- mkdir — { "name":"mkdir", "path":"src/new-dir" }
- delete_path — { "name":"delete_path", "path":"old.ts" }
- rename_path — { "name":"rename_path", "path":"old.ts", "to":"new.ts" }
- run — { "name":"run", "command":"npm test" }  (cwd = workspace; local node_modules/.bin on PATH)
- grep — { "name":"grep", "pattern":"TODO|foo", "glob":"*.ts" }
- glob — { "name":"glob", "pattern":"**/*.tsx" }
- search_symbols — { "name":"search_symbols", "query":"MyComponent" }
- find_references — { "name":"find_references", "symbol":"MyComponent" }
- lsp — { "name":"lsp", "action":"definition", "path":"src/App.tsx", "line":10, "character":8 }
- semantic_search — { "name":"semantic_search", "query":"where is auth handled" }
- related_files — { "name":"related_files", "path":"src/App.tsx" }
- retrieve — { "name":"retrieve", "query":"auth middleware" }
- web_search — { "name":"web_search", "query":"electron updater github releases" }
- web_open — { "name":"web_open", "url":"https://example.com/docs" }
- read_context — { "name":"read_context" }
- search_tools — { "name":"search_tools", "query":"notebook cell editing" }
- update_context — { "name":"update_context", "mode":"append"|"summary", "text":"…" }
- list_skills / read_skill / write_skill — skills (default scope "user")
- git_status / git_diff / git_stage / git_commit / git_sync / git_stash
- delegate_to_agent — { "name":"delegate_to_agent", "agent_id":"coder"|"reviewer"|"explainer"|"fast", "goal":"…", "summary":"…", "files":["…"], "wait":false }
- await_children — { "name":"await_children", "timeout_ms":600000 }
- ask_user — { "name":"ask_user", "question":"…", "choices":["A","B"] }
- MCP — {"name":"mcp__server__tool", ...args} when listed below. If an MCP argument itself is named name, nest args: {"name":"mcp__server__tool","arguments":{"name":"value"}}.
- Large MCP catalog — {"name":"search_mcp_tools", "query":"calendar events"}; selected tools appear on the next step

QUALITY BAR
- Prefer minimal, correct diffs over large rewrites.
- Match existing style, imports, and project conventions.
- Never invent file contents or claim you inspected files without tools.
- After every TOOL_RESULT, continue with tools until the user request is fully satisfied.
- Only then reply with a short DONE summary (what changed / findings) and no further tools.
- Empty or nearly empty workspace = greenfield: scaffold a real runnable project here (sources, manifest, README), not instructions for Xcode or another IDE.
- Build/create/make an app: inspect existing project entry points and conventions first; scaffold only when the workspace is actually empty.
- Eris AI models / providers questions: answer ONLY from the [Eris AI models] catalog — no retrieve/tree.
- Self-contained installs: npm/pnpm/yarn/bun install in this folder — never npm -g / yarn global.
- Bare npm install is OK when node_modules is missing, package.json changed, or deps are missing — do not loop install for ordinary test failures.
- Create React App: "test":"react-scripts test"; put JSX in .tsx; add Testing Library + src/setupTests.ts; run CI=true npm test -- --watchAll=false --passWithNoTests.`

export const READ_AGENT_PROMPT = `You are answering in Eris chat. The user's next message is the question. Your reply is the answer they read.

Read the open project when the answer depends on it. Paths are relative to the workspace root.
You may read workspace sources and public web pages. Do not create, edit, or delete files or commit changes. Never emit write_file, search_replace, apply_patch, mkdir, or delete_path. Shell commands are allowed only for review or verification in Agent mode, never in Ask mode.

When you need a file, emit exactly:

<<<TOOL>>>
{"name":"read_file","path":"README.md"}
<<<END>>>

Allowed tools: tree, list_dir, read_file, grep, glob, retrieve, semantic_search, web_search, web_open, search_tools.
Prefer README, package.json, and the main source. Skip .eris config unless the user asked about Eris settings.
If the user asks about the internet, the web, or who someone is, call web_search, then web_open one https result. The reply may only state facts from those results. If they do not identify the person, say so. Do not invent a biography or a workspace path from a person's name.
In Agent mode, Reviewer may run tests/typecheck for a review; Verification may run tests, typecheck, or lint only. Ask mode cannot run shell commands.

After a few reads, stop. Reply in plain sentences. Say what the project is, what it does, or what you found, and cite paths.
Do not paste a file you intend to write. Do not describe a tool call without the JSON. Do not ask the user to paste the project.`

export function isReadOnlyChat(
  plan: { toolPolicy: string; intent: string },
  mode?: 'ask' | 'agent'
): boolean {
  if (plan.intent === 'verify') return mode === 'ask'
  // Ask mode cannot mutate: an edit or run request there is answered by describing it.
  if (plan.intent === 'edit' || plan.intent === 'run') return mode === 'ask'
  return plan.toolPolicy === 'read' || plan.intent === 'explore' || plan.intent === 'review'
}
export function intentPlaybook(
  intent: ChatIntent | string,
  greenfield: boolean,
  applicability?: ScopeApplicability
): string {
  const evidence = evidenceRequirementFor(applicability)
  // A generic request is answered from the conversation; the project is not its evidence.
  if (evidence === 'none' && (intent === 'plan' || intent === 'explore')) {
    return intent === 'plan'
      ? `PLAN PLAYBOOK — Plan from the request itself. State the assumptions you make about stack, ` +
          `scale and constraints. Do not edit files or claim the plan was implemented.`
      : `ANSWER PLAYBOOK — Answer from the request itself and state your assumptions. Do not edit.`
  }
  if (intent === 'plan' && evidence === 'optional') {
    return (
      `PLAN PLAYBOOK — If the plan depends on the open project, inspect the relevant files first and ` +
      `name the files each step affects; otherwise plan from the request and state assumptions. ` +
      `Separate observed facts from assumptions. Do not edit files or claim the plan was implemented.`
    )
  }
  if (intent === 'plan') {
    return (
      `PLAN PLAYBOOK — Inspect the relevant files, tests, conventions, and dependencies before planning. ` +
      `Trace the existing flow and name the files or symbols each step affects. Return a concise ordered plan ` +
      `with dependencies, material risks, and a completion check per step. Separate observed facts from assumptions. ` +
      `Do not edit files or claim the plan was implemented.`
    )
  }
  if (intent === 'verify') {
    return (
      `VERIFICATION PLAYBOOK — Inspect the implementation, callers, and relevant tests, then look for boundary, ` +
      `error, and regression cases that happy-path checks can miss. Run only relevant tests, typecheck, or lint ` +
      `commands through the run tool; report each command and its actual output. Do not edit files, run unrelated ` +
      `commands, or claim success without observed evidence. Distinguish verified behavior from remaining risks.`
    )
  }
  if (greenfield) {
    return (
      `GREENFIELD BUILD — Start now with mkdir + write_file in this workspace. ` +
      `Scaffold a runnable project (sources, package/manifest, README). ` +
      `Do not reply with setup instructions for another IDE. Verify with run when sensible.`
    )
  }
  switch (intent) {
    case 'review':
      return (
        `REVIEW PLAYBOOK — (1) tree or retrieve to orient, (2) read_file on the important sources, ` +
        `(3) optionally run tests/typecheck, (4) answer in chat: blockers, risks, suggestions, nits. ` +
        `Cite paths. Do not edit. If the user asked what improvements to make, list them and do not implement them. ` +
        `Never ask the user for the folder structure or to paste files.`
      )
    case 'explore':
      return (
        `EXPLORE PLAYBOOK — Set the scope, then search broadly with retrieve or a distinctive symbol/query. ` +
        `Narrow through grep, glob, or symbol search, then read the relevant implementation, callers, and tests. ` +
        `If results are thin, switch search strategies; never stop at a tree or search snippet. ` +
        `Answer from inspected evidence with concrete paths and symbols, matching the depth to the question. ` +
        `If asked what the project does, read README, package.json, or the main source — not only .eris config — ` +
        `then describe what it is, what it does, and the important files. ` +
        `If the question is about the internet or who someone is, web_search then web_open one https page, ` +
        `and answer only with facts from that page. If the page does not identify them, say so. ` +
        `Do not edit. Do not invent APIs, file contents, a biography, or a path named after a person.`
      )
    case 'edit':
      return (
        `EDIT PLAYBOOK — (1) retrieve/grep to find the right files, (2) read_file, ` +
        `(3) search_replace or write_file, (4) verify with run, limited to test, typecheck, or lint commands, (5) fix failures, ` +
        `(6) DONE summary of what changed. Keep using tools until the request is fully done.`
      )
    case 'run':
      return (
        `RUN PLAYBOOK — Inspect only if needed (git_status / read_file), then run the requested command, ` +
        `report stdout/stderr clearly, and fix only if the user asked you to make it pass.`
      )
    case 'capability':
      return `CAPABILITY — Answer from the [Eris AI models] catalog only. No workspace tools.`
    default:
      return `ANSWER — Be concise and accurate. Use tools only if the question requires workspace facts.`
  }
}

export function truncateForModel(text: string, max = 12_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars for model context]`
}

export function buildWorkspaceToolsSystem(
  workspacePath: string,
  settings?: AppSettings,
  systemPrompt = TOOLS_PROMPT,
  includeMcp = true
): string {
  let tree = ''
  try {
    tree = workspaceTree(workspacePath, '.', 2)
  } catch {
    tree = '(unable to list tree)'
  }
  // Keep the injected tree long enough for the next agent to use it.
  if (tree.length > AGENT_HANDOFF_CHARS) tree = `${tree.slice(0, AGENT_HANDOFF_CHARS)}\n…`
  const parts = [
    systemPrompt,
    `WORKSPACE`,
    `Root: ${workspacePath}`,
    `You already have access to this folder via tools. Always use relative paths from the workspace root.`,
    `Current tree (depth 2 — refresh with the tree tool if you need more):\n${tree}`
  ]
  const indexSummary = formatIndexSummary(workspacePath)
  if (indexSummary) parts.push(indexSummary)
  const workspaceCtx = formatWorkspaceContextPrompt(workspacePath)
  if (workspaceCtx) parts.push(workspaceCtx)
  const canUseMcp = systemPrompt !== READ_AGENT_PROMPT && includeMcp
  const liveMcp = canUseMcp ? formatLiveMcpToolsPrompt() : ''
  if (liveMcp) parts.push(liveMcp)
  else if (settings && canUseMcp) {
    const mcp = formatMcpServersPrompt(settings)
    if (mcp) parts.push(mcp)
  }
  const readBatching =
    `For independent read-only checks, request up to four tools in the same turn so they can run in parallel. ` +
    `Do not batch writes or operations that depend on earlier results.`
  parts.push(readBatching)
  return parts.join('\n\n')
}

/**
 * The task guidance block already carries the shared rules, workspace rules,
 * active skills and custom role prompt. Drop the chat prompt's copies by their
 * exact generated text so each appears once.
 */
export function withoutSharedBlocks(
  priorSystem: string,
  workspacePath: string | null,
  settings: AppSettings,
  extra: { skillIds?: string[]; customAgentPrompt?: string } = {}
): string {
  let out = priorSystem
  for (const mode of ['agent', 'ask'] as const) {
    const shared = sharedPromptBlocks(workspacePath, settings, mode, extra.skillIds)
    for (const block of [shared.systemPrompt, shared.rules, shared.skills]) {
      if (block && out.includes(block)) out = out.replace(block, '')
    }
  }
  for (const max of [2800, 8000]) {
    const custom = extra.customAgentPrompt?.slice(0, max)
    if (custom && out.includes(custom)) out = out.replace(custom, '')
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** Guidance blocks in precedence order, each included once by identity. */
function workerGuidance(blocks: Array<{ id: string; content: string | undefined }>): string {
  const seen = new Set<string>()
  return blocks
    .filter((block) => {
      if (!block.content?.trim() || seen.has(block.id)) return false
      seen.add(block.id)
      return true
    })
    .map((block) => block.content!.trim())
    .join('\n')
}

/**
 * The single worker prompt pipeline: compiled task contract, typed guidance,
 * project evidence and retrieval. Answer-only turns use the same compiler.
 */
export function buildPreservedWorkerMessages(options: {
  messages: AgentChatMessage[]
  workspacePath: string
  settings: AppSettings
  plan: TurnPlan & { task: TaskContract }
  originalUserGoal: string
  retrievalHint: string
  mcpToolCount: number
  inputTokenBudget?: number
  conversationMemory?: import('../../../../src/shared/context-memory').MemoryPrompt
}): AgentChatMessage[] {
  const { plan } = options
  const task = plan.task
  const priorSystem = options.messages.find((m) => m.role === 'system')?.content || ''
  const historyTail = workerConversation(options.messages, options.originalUserGoal)
  const contract = contractForAgent(plan.agentId)
  const agent = findAgent(options.workspacePath, plan.agentId)
  const customAgentPrompt = agent?.builtin === false ? agent.systemPrompt : undefined
  const compiled = compileTaskContext({
    task,
    toolsAvailable: plan.toolPolicy !== 'none',
    toolProtocol: toolProtocolFor(options.settings, plan.models.tools),
    guidance: workerGuidance([
      { id: 'shared-rules', content: options.settings.agent.systemPrompt },
      { id: 'workspace-rules', content: loadWorkspaceRules(options.workspacePath) },
      {
        id: 'skills',
        content: task.skillIds?.length ? loadSkillsPrompt(options.workspacePath, task.skillIds) : ''
      },
      { id: 'custom-role', content: customAgentPrompt },
      {
        id: 'role',
        // Role identity once. Its job text describes workspace reading, which a generic
        // request must not reintroduce; the playbook and response contract cover the rest.
        content: contract
          ? evidenceRequirementFor(task.scope.applicability) === 'none'
            ? `Role: ${contract.name}.`
            : `Role: ${contract.name}. ${contract.job} ${contract.done}`
          : ''
      },
      { id: 'playbook', content: intentPlaybook(plan.intent, false, task.scope.applicability) },
      {
        id: 'response-contract',
        content: artifactResponseContract(interpretationOf(task), task.scope.applicability)
      }
    ]),
    project: withoutSharedBlocks(priorSystem, options.workspacePath, options.settings, {
      skillIds: task.skillIds,
      customAgentPrompt
    }),
    ...memoryForDestination(options.conversationMemory, options.plan.models.tools),
    retrieval: options.retrievalHint,
    maxInputTokens:
      options.inputTokenBudget ?? contextBudgetTokens(options.settings, plan.models.tools)
  })
  appendTaskEvent(task.taskId, 'context-compiled', {
    revision: task.revision,
    agentId: plan.agentId,
    model: plan.models.tools,
    blocks: compiled.blocks,
    budget: compiled.budget,
    bundle: compiled.bundle
  })
  return [compiled.message, ...historyTail, { role: 'user', content: options.originalUserGoal }]
}
