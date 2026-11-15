# Using Eris

Eris is a desktop IDE built around a coding agent. You open a project folder, describe what you want in chat, and review each change the agent makes, hunk by hunk, before you keep it.

## Install

Download the installer from the [latest release](https://github.com/EricServices-Repo/Eris/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Eris-<version>-mac-arm64.dmg` or `.zip` |
| Windows (x64) | `Eris-<version>-win-x64-setup.exe` |

Eris checks the same releases for updates (Eris → Check for Updates…). If a build isn't signed, the update opens the release page for a manual install instead.

## First run: connect a model

Eris doesn't bundle a model; you choose where inference runs. The welcome screen opens **Settings → Models**, where you can set up any of these:

| Option | Where | Code leaves your machine? |
|---|---|---|
| **Local GGUF model** | Settings → Text Models: search Hugging Face and download | No |
| **Ollama or LM Studio** on this computer | Settings → Providers | No (loopback server) |
| **Eris Cloud** | Settings → Cloud Models: sign in to EricServic.es and it turns on automatically | Yes, to Eris Cloud |
| **OpenAI-compatible API** (OpenAI, OpenRouter, Groq, Together, DeepSeek, custom) | Settings → Providers: add the base URL and API key | Yes, to that provider |

API keys are stored by the main process, either in a local file or the OS vault. The UI never reads them back.

## Open a project and chat

1. **File → Link Folder as Workspace…** (⌘O / Ctrl+O) opens an existing folder. **New Workspace…** (⌘⇧N / Ctrl+Shift+N) creates one.
2. **Agent → New Chat** (⌘L / Ctrl+L).
3. Choose a mode:
   - **Ask** answers questions. It can read the project but never changes files.
   - **Agent** reads, edits, runs commands and verifies the result.
4. Type your request. `@` attaches a file and `/` attaches a skill. `/image <prompt>` generates an image. Enter sends; Shift+Enter adds a new line.
5. Messages you send while a reply is running are queued, up to three.

While the agent works, the chat shows the current phase (for example "Understanding request", "Using workspace tools", "Checking results"), tool cards, and a **Thinking** section. Thinking contains Eris's progress steps and, for reasoning models, the model's own reasoning. **Stop** (Agent → Stop Generation) ends the run and keeps the partial reply.

## Choose the agent and the model

These are two separate choices.

**Agent** picks the role. Leave it on **Auto** or pin one:

| Agent | Does |
|---|---|
| **Agent** | Changes, builds and multi-step work. Delegates when the task splits. |
| **Coder** | One assigned change, small diff. |
| **Explainer** | Explains how the code behaves. Doesn't edit. |
| **Reviewer** | Reports bugs, risks and missing tests. Doesn't edit. |
| **Plan** | Writes a sequenced plan grounded in the project. Doesn't edit. |
| **Verification** | Checks changes adversarially. Doesn't edit. |
| **Fast** | A few sentences for a short lookup. |

**Model** picks where the turn runs:

- **Auto (this computer only)**: local GGUF models and Ollama or LM Studio on this machine. Nothing is sent to a remote server.
- **Auto (any connected model)**: any enabled model, local or remote.
- **A named model**: exactly that model. Eris Cloud models appear as `cloud:<model>`.

Set **Auto preference** (prefer best, local or cheapest) in Settings → Models.

Settings → Models also has a **Primary model** and a **Fast model**. Composer, Coder, Plan, Verification and Reviewer run on the primary model. Explainer and Fast run on the fast model, which defaults to *Auto-fast*: the cheapest eligible model at tier standard or below, under the same privacy policy. A role can change its class in Settings → Agents, and a model pinned on a role overrides its class. With one model available, both classes use it. How Auto ranks models is described in [automatic model selection](design/AUTO-MODEL-EXECUTION.md).

## Review changes

In Agent mode, edits are written to disk and shown as pending hunks in the editor.

- **Keep** accepts a hunk.
- **Undo** restores the original text from its checkpoint.
- To skip review, turn on automatic keep (`agent.autoKeepDiffs`).

Shell commands, pushes and MCP calls ask for approval by default. "Always allow" remembers an exact command for this workspace.

## Editor and tools

| Feature | How |
|---|---|
| Inline edit | ⌘K / Ctrl+K in the editor |
| AI completion | Alt+\ to request; Tab accepts the ghost text |
| Go to definition | F12 (TypeScript language server, with a symbol-index fallback) |
| Search in files | Command palette → Search in Files |
| Terminal | Command palette → Toggle Terminal |
| Source control | Stage, commit, branches and stash in the Git panel. Link a GitHub repository to sync, open and create pull requests. |
| Run & Debug | Node launch configurations in `.eris/launch.json`, or a configured stdio DAP adapter |
| Code map | Code index statistics and rebuild |
| Background agents | The Agents panel lists background jobs. Each runs in its own git worktree for review and merge. |
| Images | `/image <prompt>`, or ask the agent to create one. Local Diffusers or an Images API ([guide](image-generation.md)) |

The command palette is ⌘⇧P / Ctrl+Shift+P.

## Teach Eris about your project

| What | Where | Settings page |
|---|---|---|
| Rules the agent must always follow | `.eris/rules/*.md` | Rules |
| Project notes the agent keeps | `.eris/context.md` | Context |
| Custom agents | `.eris/agents.json` | Subagents |
| Skills (reusable workflows) | `.eris/skills/` or your user skills folder | Skills |
| MCP servers | Settings | MCP |
| Workspace settings | `.eris/settings.json` | Workspace |

User settings live in `~/Library/Application Support/Eris/` on macOS and `%APPDATA%\Eris\` on Windows. Workspace settings override user settings. Settings from an untrusted workspace are restricted until you trust it.

Conversation memory (Settings → Memory) controls how much history is kept in RAM and recalled into each turn. Recall is not shared with remote models unless you turn that on. See [conversation memory](CONTEXT-MEMORY.md).

## Account, Eris Cloud and usage

Signing in under **Settings → Account** links this computer to your EricServic.es profile. It turns on:

- **Sync** of settings, projects, chats and skills between computers ([account sync](PROFILE-SYNC.md)). Project files, model weights and API keys are not uploaded.
- **Eris Cloud** hosted models, under Settings → Cloud Models.

**Settings → Usage** shows weekly model usage on this computer and the Eris Cloud plans:

- **Free** includes 1,000,000 Eris Cloud tokens per week.
- **Pro** is unlimited.

Local models and your own providers don't count toward the allowance. Without an account, everything except Eris Cloud and sync still works.

## Feedback

**Help → Send Feedback…** files a redacted report as an issue in [EricServices-Repo/Eris](https://github.com/EricServices-Repo/Eris/issues). See [feedback](FEEDBACK.md).

## Shortcuts

| Action | macOS | Windows |
|---|---|---|
| Open folder | ⌘O | Ctrl+O |
| New workspace | ⌘⇧N | Ctrl+Shift+N |
| Save | ⌘S | Ctrl+S |
| Settings | ⌘, | Ctrl+, |
| Command palette | ⌘⇧P | Ctrl+Shift+P |
| New chat | ⌘L | Ctrl+L |
| Inline edit | ⌘K | Ctrl+K |
| Request completion | ⌥\ | Alt+\ |
| Go to definition | F12 | F12 |
| Send message / new line | Enter / Shift+Enter | Enter / Shift+Enter |
