# Eris account profile sync, version 2

The authenticated `GET` / `PUT /api/eris/v1/settings.php` API stores one profile per EricServic.es username. Tokens determine the owner; clients cannot supply a different owner. `me.php` reports sync capabilities and project, chat, skill, MCP, and Ollama counts. The Control Hub Eris page shows saved projects.

Apply `sql/migrations/20261104_eris_profile_workspace.sql` before deploying these endpoints. The existing `eris_profile_settings` row is retained, with LONGTEXT storage and microsecond server versions. The nginx location for settings uploads must permit 13 MB; the application rejects payloads exceeding 12,000,000 bytes without changing the existing profile.

## Request and restore contract

Send `{settings, bundle: {version: 2, userSkills, projects, chats}, clientUpdatedAt}`. Each project contains `id`, `name`, `repositoryUrl`, `createdAt`, `lastOpenedAt`, `skills`, and `chats`. `chats` at the bundle root contains conversations outside projects. Each chat contains `id`, `title`, `model`, millisecond `createdAt` / `updatedAt`, and the **complete** `messages` array. Messages retain `id`, `role`, `content`, `thinking`, `createdAt`, `agentId`, `agentName`, and `model` when supplied. Uploaded partial pages are rejected. Local image files and runtime tool state are not uploaded.

Project IDs remain stable across computers. Absolute folder paths are not stored. Repository URLs accept HTTPS and `git@host:path` metadata, without embedded HTTPS credentials or query tokens. They are never fetched by the server. Project files and Ollama model weights are not uploaded. Model connections, including Ollama endpoints and model names, and MCP server definitions remain in `settings.models` and `settings.mcp`. API key references and MCP environment values stay local; environment variable names are synced as empty placeholders.

On a new computer, Eris creates private project metadata folders, restores chats and skills, and lists the projects. Opening a restored project asks the user to select a local checkout or empty folder. Eris copies the restored chats and skills into that folder and preserves the cloud project identity. Cloning repository contents remains a user action.

## Concurrency and older clients

Pull first. Echo the exact `updatedAt` string from the response as `clientUpdatedAt` on the next push. Initial creation may omit the version. Existing rows require an exact version; missing or stale versions return HTTP 409 with the current settings, bundle, and version. Compare the full opaque string rather than converting it to milliseconds. Updates lock the owner's row inside a transaction, including simultaneous initial writes.

Older settings / skills clients remain supported. A missing bundle collection preserves its saved value; an explicitly supplied empty collection clears it on the server. Desktop restoration merges projects and chats without deleting local-only records, and preserves a more recently edited local conversation. Diverged message histories are saved as separate chats labeled “other device”. Deletions are not propagated as tombstones. Skills are restored by ID. Desktop sync runs on sign-in, manually, and once per minute while account sync is enabled; local paths and credentials are retained.

The Eris desktop changes require a new desktop build. Deploying the PHP API alone does not add project uploads to older Eris binaries.
