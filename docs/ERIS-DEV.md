# Eris-Dev

Eris-Dev is a separate desktop app for inspecting what Eris agents prepare for a model. Its application ID is `app.eris.dev`; it stores data under `Eris-Dev` in the OS application-data directory and does not register the production IDE's updater.

## Use

1. Open `dist-dev/mac-arm64/Eris-Dev.app` after building.
2. Import a TXT file (one question per nonempty line), a JSON array of strings or `{ "question": "..." }` / `{ "text": "..." }` objects, or equivalent JSONL records. JSON supports multiline questions, a record may carry `"intentReply": { "intent": "review", "confidence": 0.9 }` to script the intent resolver for that question, and `"history": [{ "role": "user" | "assistant", "content": "…" }]` (up to 40 messages) to capture it as a follow-up in a conversation, for example “Implement those” after a review. Files can contain up to 10,000 questions (after normalization) and be up to 20 MB; individual questions are limited to 32,000 characters. Invalid records reject the import with an error.
   - TXT imports are normalized and the result is shown: a numbered list (`1. …`) loses its numbers and unnumbered lines are excluded; in an unnumbered list of questions, up to ten leading heading lines are excluded. Every excluded line is listed with its line number and reason.
   - Each question gets a content-derived ID (`<sha256 prefix>-<occurrence>`) and its original line number, so the same question can be found across reordered or chunked imports, and duplicates stay separate.
3. Choose the workspace: the built-in **Sample** fixture (`divide(a, b)`), **No project** for workspace-independent questions, or **Choose project** to copy a folder. Copies are limited to 3,000 entries and 20 MB. Workspace rules and configuration in `.eris/`, `.github/` and `.vscode/` are kept; possible secrets (`.env*`, keys, credential files), `.git`, Eris workspace state, other hidden entries, symlinks, dependency folders and build outputs are omitted. The export header lists every omitted category with examples. Oversized snapshots fail explicitly.
4. Choose Agent or Ask mode, the intent reply (fallback with confidence 0, malformed JSON, or timeout) and a context budget. Click **Capture requests**.
5. Select a question and inspect Messages, Tools, Findings, Context, Contract or Events. Requests from separate stages appear in the request dropdown. The Context tab shows the route decision, retrieval, workflow adjustments, and each request's context manifest and tool capability record. A blocked/error result explains why the model boundary was not reached.
6. Export completed or stopped runs as JSONL. The first line is the run header, followed by a record for each processed question. The export contains actual prompt text and any source excerpts included by the pipeline; review it before sharing.

## Statuses

Each question reports independent stages, and none of them is an answer-quality result:

- **Reachability** — whether the request reached the model transport boundary (`captured`, `blocked`, `error`, `cancelled`).
- **Request validity** — deterministic invariants over the task contract, prompt and tools (`no-findings`, `review`, `defects`). Findings have stable IDs such as `answer-requires-mutation`, `domain-model-as-capability` or `disabled-tool-exposed`. No findings means the request is coherent, not that an answer would be good.
- **Inference** — always `not-run`.
- **Answer quality** — always `not-evaluated`. A capture never contains a model answer.

Durations are local **pre-inference** timings split into route, resolve, prompt and to-boundary phases. They are not model latency or generation speed.

## Export format (v2)

The header (`format: "eris-dev-capture-v2"`) records the app version, Git SHA and dirty state when available, routing and prompt versions, a digest of the capture settings, the corpus ID and exclusion count, the fixture kind, digest, file count and omissions, the context budget, mode and intent reply mode, and states `responses: "none"` and `answerQuality: "not-evaluated"`.

Each record has `questionId`, `sourceLine`, `stages`, `findings`, `findingsDetail`, `phases`, `routeDecision`, `retrieval`, and per-request `context` and `toolManifest`. `response` is always `null` with `responseReason: "not-generated"`, and `intentReplySource` names who supplied the intent reply. `readCaptureRecord` in `src/shared/eris-dev.ts` reads v1 records as `responseReason: "not-observed-v1"`, so an older file never appears to contain answers.

Every question is an independent chat turn. Processing is sequential, cancellable and bounded by a 30-second per-question timeout. Results are written individually to disk rather than retaining all prompt bodies in the renderer; the question list shows 100 entries per page. Captures remain in the app's `captures/` directory after closing, and JSONL files there can be copied for review. There is currently no UI for reopening prior runs or automatic retention pruning.

## What is captured

The app calls production `planInitialChatTurn`, `resolveChatTurnContract`, `buildChatTurnMessages` and `runAgentWithWorkspaceTools`. A scoped diagnostics adapter intercepts the common model transport and captures messages, tool schemas, requested temperature, purpose, model reference and output schema. It stops the agent as soon as the first agent model request arrives.

This is a **pre-inference request inspection** tool. It uses the simulated model profile and default settings with the chosen context budget. It does not invoke a downloaded model or a remote API. A semantic-intent model request is captured if needed, then receives the selected labelled reply. The resolver's actual decision, including any conservative downgrade and the rule that caused it, is recorded in the route decision and events. Agent responses and subsequent tool cycles are not simulated; use the in-app diagnostics runs (scripted or real-model scenarios) for those. Diagnostics scenarios can have follow-up turns that share the thread, sandbox and previous task, so review → “implement those” → “what did you change?” runs end to end. Capture success means a model request was observed, not that the task would succeed or that routing is correct. This boundary precedes provider-specific message serialization and tokenization.

External effects are guarded by the existing diagnostics scope. Source tools operate on the temporary snapshot. MCP, delegation and command approvals are disabled. The app uses its own data root, with no production credentials or settings loaded.

## Build

- `npm run build:dev-app` — focused tests and standalone main/preload/renderer build into `out-dev/`.
- `npm run dist:dev-app:mac` — package `Eris-Dev.app` under `dist-dev/mac-arm64/` on Apple Silicon.
- `npm run start:dev-app` — build the macOS bundle and open it.
- `npm run dist:dev-app:win` — build the Windows NSIS installer (run on Windows).
- `npm run test:dev-app` — import validation and normalization, stable IDs, cancellation, production-boundary capture checks that assert no network call and unchanged source files, and a release gate: the review's named questions must reach the boundary with no request-level defects.

The dev app has a separate Vite config, preload API and Electron Builder config. Production Eris builds and release feeds are independent. Neither dev-app build command publishes a GitHub release.
