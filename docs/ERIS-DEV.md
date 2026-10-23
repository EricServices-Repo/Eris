# Eris-Dev

Eris-Dev is a separate desktop app for inspecting what Eris agents prepare for a model. Its application ID is `app.eris.dev`; it stores data under `Eris-Dev` in the OS application-data directory and does not register the production IDE's updater.

## Use

1. Open `dist-dev/mac-arm64/Eris-Dev.app` after building.
2. Import a TXT file (one question per nonempty line), a JSON array of strings or `{ "question": "..." }` / `{ "text": "..." }` objects, or equivalent JSONL records. JSON supports multiline questions. Files can contain up to 10,000 questions and be up to 20 MB; individual questions are limited to 32,000 characters. Invalid records reject the import with an error.
3. Optionally choose a source project. The default is a small fixture containing `divide(a, b)`. Selected projects are copied to a temporary directory with a limit of 3,000 entries and 20 MB. Hidden entries, symlinks, dependency folders and build outputs are omitted. Oversized snapshots fail explicitly.
4. Choose Agent or Ask mode and a context budget. Click **Capture requests**.
5. Select a question and inspect Messages, Tools, Contract or Events. Requests from separate stages appear in the request dropdown. A blocked/error result explains why the model boundary was not reached.
6. Export completed or stopped runs as JSONL. The first line contains run metadata, followed by a record for each processed question. The export contains actual prompt text and any source excerpts included by the pipeline; review it before sharing.

Every question is an independent chat turn. Processing is sequential, cancellable and bounded by a 30-second per-question timeout. Results are written individually to disk rather than retaining all prompt bodies in the renderer; the question list shows 100 entries per page. Captures remain in the app's `captures/` directory after closing, and JSONL files there can be copied for review. There is currently no UI for reopening prior runs or automatic retention pruning.

## What is captured

The app calls production `planInitialChatTurn`, `resolveChatTurnContract`, `buildChatTurnMessages` and `runAgentWithWorkspaceTools`. A scoped diagnostics adapter intercepts the common model transport and captures messages, tool schemas, requested temperature, purpose, model reference and output schema. It stops the agent as soon as the first agent model request arrives.

This is a **pre-inference request inspection** tool. It uses the simulated model profile and default settings with the chosen context budget. It does not invoke a downloaded model or a remote API. A semantic-intent model request is captured if needed, then receives a labelled simulated response with confidence zero so the deterministic route is retained. Agent responses and subsequent tool cycles are not simulated. Capture success means a model request was observed, not that the task would succeed or that routing is correct. This boundary precedes provider-specific message serialization and tokenization.

External effects are guarded by the existing diagnostics scope. Source tools operate on the temporary snapshot. MCP, delegation and command approvals are disabled. The app uses its own data root, with no production credentials or settings loaded.

## Build

- `npm run build:dev-app` — focused tests and standalone main/preload/renderer build into `out-dev/`.
- `npm run dist:dev-app:mac` — package `Eris-Dev.app` under `dist-dev/mac-arm64/` on Apple Silicon.
- `npm run start:dev-app` — build the macOS bundle and open it.
- `npm run dist:dev-app:win` — build the Windows NSIS installer (run on Windows).
- `npm run test:dev-app` — import validation, cancellation, and production-boundary capture checks that assert no network call and unchanged source files.

The dev app has a separate Vite config, preload API and Electron Builder config. Production Eris builds and release feeds are independent. Neither dev-app build command publishes a GitHub release.
