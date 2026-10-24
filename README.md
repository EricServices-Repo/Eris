# Eris

Eris is a desktop IDE for writing software with agents. You open a project folder, talk to an agent in the chat, and review the edits in the file they change.

The agent decides how the turn is handled: whether to read, edit, review, or explain. The model menu decides which model runs that turn. Those are separate choices.

See the [architecture reference](docs/ARCHITECTURE.md) for the current implementation and [next fixes](docs/RECOMMENDATIONS.md) for the prioritized backlog.

**[Download the latest release](https://github.com/EricServices-Repo/Eris/releases/latest)** for macOS (Apple Silicon) and Windows (x64).

| Platform | Installer |
|----------|-----------|
| macOS | `Eris-<version>-mac-arm64.dmg` or `.zip` |
| Windows | `Eris-<version>-win-x64-setup.exe` |

In-app updates check [this repository’s releases](https://github.com/EricServices-Repo/Eris/releases). No GitHub token is required. Unsigned builds may need a manual install from the release page.

The checked-in version is defined in [package.json](package.json).

## What you can do

- Open a folder and work in that project. The terminal, tests, and agent commands run inside it.
- Ask a question about the code, or hand the agent a change to make.
- Pick **Auto** and let Eris choose the agent and, if you want, the model. Or pin both.
- Review each edit as hunks in the open file. Accept writes it in. Reject restores the previous text.
- Run **Composer Lite** on your machine, **Composer Full** on Cloud Agents, a downloaded GGUF, or a connected provider such as Ollama or an OpenAI-compatible API.
- Sign in with an [EricServic.es](https://www.ericservic.es) account to sync preferences and use Cloud Agents. Local chat stays available without an account.

## Features

### Chat

The chat is the front door. **Ask** answers without editing. **Agent** can read the project, change files, and run checks.

Type `@` to attach a file and `/` to attach a skill. Enter sends. Shift+Enter inserts a line break.

### Agents

An agent is the role that processes the message: instructions, tools, and when it is finished. It does not replace the model you picked.

| Agent | What it does |
|-------|----------------|
| **Auto** | Chooses Composer, Explainer, Reviewer, or Fast from the message. |
| **Composer** | Inspects the project, makes the change, and verifies it. Delegates only when the work splits. |
| **Explainer** | Reads the code and explains it. Does not edit. |
| **Reviewer** | Reports bugs, risks, and missing tests. May run the project’s test or typecheck command. Does not edit. |
| **Fast** | Answers a short lookup in a few sentences. |
| **Coder** | Implements one assigned change. Pin it, or let Composer delegate to it. |

A delegated agent works in the same folder and shows its goal, tools, and result in the thread. Pin an agent when you want that role on every turn. The pin is remembered.

### Models

The model menu lists every model that is ready:

- **Auto** chooses one for the turn. An edit can use Composer Full when Cloud Agents are allowed. Otherwise it uses Composer Lite, then a ready local or connected model.
- **Composer Lite** runs locally.
- **Composer Full** runs on Cloud Agents. If Cloud is unavailable, that turn continues on Composer Lite.
- **Local models** you download (GGUF) and **connected providers** that are enabled.

A model you pick is the model that runs. The agent still shapes the instructions and the tools.

### Editor, Git, and terminal

Edits stay out of the buffer until you accept them. Pending changes appear as hunks in the open file.

The IDE includes a file tree, Monaco editor, search, Git, a terminal, and diagnostics. Agent commands stay in the workspace and cannot install packages globally.

### Project memory, rules, and skills

Each workspace can keep its own instructions:

| What | Where |
|------|--------|
| Workspace settings | `<folder>/.eris/settings.json` |
| Agents | `<folder>/.eris/agents.json` |
| Rules | `<folder>/.eris/rules/` |
| Project memory | `<folder>/.eris/context.md` |

User settings live outside the project: `~/Library/Application Support/Eris/` on macOS, `%APPDATA%\Eris\` on Windows. Workspace settings override user settings. API keys stay on the machine.

MCP servers and skills extend what an agent can do. Add them in Settings.

### Account and Cloud Agents

Sign in from Settings to link this Mac or PC to EricServic.es.

- **Free** includes local chat. Cloud Agent jobs are capped over a rolling 30 days.
- **Pro** removes that Cloud Agent cap.

Usage for this device and the account is in Settings → Usage.

### Feedback and updates

**Help → Report a Bug** files an issue on [EricServices-Repo/Eris](https://github.com/EricServices-Repo/Eris/issues). Diagnostics and logs are redacted before they are sent.

Eris checks this repository for updates. Install from a release build to update in place. A locally built unsigned app can open the release page instead.

## Usage

1. Install Eris from the [latest release](https://github.com/EricServices-Repo/Eris/releases/latest).
2. Open a project folder (**File → Open**, or ⌘O / Ctrl+O).
3. Start a chat (⌘L / Ctrl+L).
4. Leave **Agent** on **Auto**, or pin Composer, Explainer, Reviewer, Fast, or Coder.
5. Leave **Model** on **Auto**, or pick Composer Lite, Composer Full, a local model, or a connected provider.
6. Describe the change or the question. Attach files with `@` when you want the agent to start from a specific path.
7. In Agent mode, accept or reject the hunks in the editor before you keep the result.
8. Optional: sign in under Settings → Account if you want Cloud Agents or synced preferences.

### Shortcuts

| Action | macOS | Windows |
|--------|-------|---------|
| Open folder | ⌘O | Ctrl+O |
| New workspace | ⌘⇧N | Ctrl+Shift+N |
| Save | ⌘S | Ctrl+S |
| Settings | ⌘, | Ctrl+, |
| Command palette | ⌘⇧P | Ctrl+Shift+P |
| New chat | ⌘L | Ctrl+L |
| Send message | Enter | Enter |
| New line in chat | Shift+Enter | Shift+Enter |

## Develop

Requirements: Node.js 20 or newer. macOS or Windows for the desktop app.

```bash
npm install
npm run dev
```

Checks:

```bash
npm test
npm run check
```

### Build

| Command | Result |
|---------|--------|
| `npm run dist:mac` | Unsigned macOS app in `dist/mac-arm64/Eris.app` |
| `npm run dist:release:mac` | macOS `.dmg` and `.zip` |
| `npm run dist:release:win` | Windows setup `.exe` |

Build each platform on that platform, or let GitHub Actions do both. A `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which uploads the macOS and Windows installers to [this repository’s releases](https://github.com/EricServices-Repo/Eris/releases).

```bash
npm run release          # do not use; prepare release changes by PR as described in docs/GITHUB-WORKFLOW.md
npm run release:github   # tag the integrated version from the approved release source
npm run release:dry      # print the plan only
```

See [GitHub integration workflow](docs/GITHUB-WORKFLOW.md) for branch and release rules. Work lands on task branches and enters `dev` through pull requests. The planned `dev` → `main` promotion is the v1.0.1 release; the branch model after that promotion must be documented before further integration.

## License

[MIT](LICENSE)
