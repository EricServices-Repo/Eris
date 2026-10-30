# Detailed conversation memory

For the detailed **target** design, implementation work packages and acceptance gates, see [RAM-CONTEXT-ARCHITECTURE.md](RAM-CONTEXT-ARCHITECTURE.md). That specification distinguishes proposed changes from the implemented behavior below.

## Implemented behavior

Eris now keeps a large, detailed, bounded copy of saved conversation history in the Electron main process. A new chat message can retrieve relevant older evidence even when the renderer has loaded only the newest page. The model receives a small selection, rather than the entire RAM history.

This is an implementation of the RAM context design. It does not increase a model's context window or replace its inference/KV cache. It does not perform model inference to summarize history.

The durable source remains the existing per-workspace or user-profile SQLite transcript. Pins and recall exclusions are stored beside that transcript. Restarting or evicting the RAM copy does not delete history.

## Ownership and data flow

1. The renderer sends the current request, thread ID, attachments and preferences. Its `prompt.history` is empty for normal thread-bound submissions.
2. Main validates that the thread belongs to the pinned workspace and admits the request using the existing job controller.
3. Main appends the user message with `${requestId}:user`. The renderer's optimistic append uses the same ID, so concurrent saves are idempotent.
4. The append returns a recent canonical tail. Main uses up to 20 previous messages for existing routing, intent resolution, task construction and ordinary prompt compaction. Loading more UI pages cannot enlarge the submission.
5. A separate context worker lane pages detailed history from SQLite. The main-owned store retains complete message text within configured logical limits. It strips reasoning traces and image payloads.
6. After task scope resolves, main selects historical evidence for the current question and filters task receipts recorded for another project root.
7. The agent runner passes the selection to the shared prompt compiler. Both answer-only and tool-worker paths can include it as an optional evidence block. Current task and Eris instructions are compiled first.
8. Streamed visible output, image references, thinking traces and specialist delegations are accumulated in main, including replacement events. Main and renderer share the same final reply formatter. Main saves `${requestId}:assistant` before publishing terminal success, incomplete or stopped state. The renderer's terminal save uses the same ID and does not duplicate it.
9. Saved appends update a warm RAM entry. Conversation rewrites, rewinds and deletion invalidate the entry and fence in-flight hydration.

A storage failure after generation publishes a chat error rather than falsely reporting a successfully saved turn. Initial user-message storage failure prevents model execution.

## Source files

- `electron/main/services/context-memory-store.ts`: bounded cache, lifecycle, deterministic selection and selection manifest.
- `electron/main/services/context-memory.ts`: canonical profile/workspace/thread keys, worker hydration, durable controls and mutation integration.
- `src/shared/context-memory.ts`: settings, manifests, inspection types and validated controls.
- `electron/main/services/chat-database.ts`: monotonic context revision, bounded history pages and durable control records.
- `electron/main/services/workspace-worker-client.ts`: dedicated `context` lane, separate from chat writes and repository indexing.
- `electron/main/ipc/chat-stream.ts`: canonical admission history, memory selection and durable terminal reply ordering.
- `electron/main/services/agent/context-compiler.ts`: optional `memory` evidence block within the model's existing input budget.
- `electron/main/services/agent/prompts.ts` and `agent/loop.ts`: model-specific inclusion at worker compilation, recompilation and answer-only turns.
- `src/features/chat/ContextMemoryInspector.tsx`: recall preview, explicit pins, exclusions and RAM reload.

## Default capacity

The `agent.contextMemory` settings are schema validated and available under Settings → Agent:

- `enabled`: true.
- `maxMemoryMiB`: 128, configurable from 16 through 512.
- `maxThreadMiB`: 32, configurable from 4 through 128; the effective thread cap is no larger than the global cap.
- `maxMessages`: 25,000 per conversation, configurable from 500 through 100,000.
- `warmThreads`: 8, configurable from 1 through 16.
- `idleMinutes`: 30, configurable from 1 through 120.
- `promptTokens`: 1,024 estimated tokens, configurable from 128 through 4,096.
- `shareWithRemoteModels`: false.

The RAM budgets use conservative logical accounting: four times the UTF-8 serialized message/control size plus fixed per-record overhead. They are **not hard RSS ceilings**. V8 representation, snapshots held by active selections, SQLite connections, bounded worker transfers and concurrent hydration add temporary overhead. Two hydration jobs can run concurrently; excess attempts fall back to canonical recent history and can retry later.

Reducing settings trims already warm entries. Oldest retained messages leave RAM first when a thread exceeds its limit. Least recently used conversations leave RAM when the global or warm-thread limit is exceeded. Idle entries are swept approximately once per minute and also expire on access. The detailed transcript remains on disk.

## Hydration and consistency

Each conversation has a monotonic `contextRevision`. Appends and saved rewrites increment it independently of timestamps. Retrying the same message ID does not add another row or advance the revision.

Each context page:

- Reads the header and rows in a SQLite read transaction.
- Returns at most 500 records.
- Transfers at most approximately 2 MB of serialized row data.
- Advances its ordinal cursor over oversized rows, reports omissions and avoids an infinite retry at the same row.
- Carries the revision, total count, next cursor and completion flag.

Hydration stops at configured count/byte limits and marks incomplete coverage. All pages in a snapshot must have the same revision. A changed revision abandons the mixed snapshot; the foreground lookup retries once. A generation token also fences a pending load after clear, append, settings disable or replacement. Activity in a different conversation does not invalidate the token. Tombstone bookkeeping is bounded.

The newest coherent transcript is preferred over a stale but apparently complete snapshot. If hydration fails or its admission is busy, chat continues with the canonical recent history. A `memory-selected` task event records manifest metadata when selection completes; unavailable coverage is visible rather than presented as complete recall.

## Selection algorithm

Selection uses deterministic local code and does not require an embedding model or an additional LLM call:

1. Normalize up to 24 useful query terms.
2. Scan retained records cooperatively, yielding to Electron every 128 records and honoring cancellation.
3. Score lexical matches, explicit user constraints/preferences and recency.
4. Keep at most 128 candidates while scanning, bounding temporary candidate storage.
5. Extract a relevant excerpt around matches, rather than always taking the first sentence.
6. Classify user statements, prior assistant answers, numbered recommendations, historical task receipts and explicit pins.
7. Omit secret-like excerpts containing common credential assignment patterns or bearer credentials. This is a heuristic, not comprehensive secret detection.
8. Select up to 24 facts within the configured recall budget, using the same conservative three-characters-per-token estimate as the context compiler.
9. Let the shared compiler further truncate optional evidence to fit its system-context allocation, after the required task and instructions.

The complete retained messages remain available in RAM even though the selected prompt contains excerpts. A query can therefore recall a buried relevant passage on a later turn without rereading every UI page.

Selection IDs derive from source identity and excerpt location. Manifests record hashed source IDs, revision, generation, total and retained counts, earliest retained ordinal, logical size, coverage, selected IDs, estimated tokens and omitted candidate count. Raw recalled text is not copied into the `memory-selected` event.

## Trust, scope and privacy

Recalled content is historical **evidence**. It does not set tool permissions, shell approvals, execution scope or the current user goal. It is compiled after the authoritative task and instructions. Assistant prose is explicitly unverified. A recorded task outcome describes the original task, not the present repository state; a changed-files receipt is not proof that today's tests pass.

Memory is keyed by canonical workspace, thread and application user-data profile. Conversations do not share recalled history. Workspace switching cannot retrieve another workspace's entry by reusing a thread ID. Historical task receipts with a different recorded project root are excluded from the model selection. Ordinary user statements remain scoped to their conversation: this implementation does not automatically classify every statement as a reusable project fact or promote facts across threads.

The deterministic task-intake path continues to use canonical recent conversation and its existing durable typed prior task. Older RAM excerpts are not inserted into task-authority construction. Ambiguous references should be clarified rather than letting recalled assistant prose redefine the contract.

Additional recalled history is sent to native local model references (`local:` and `builtin:`) by default. For remote model workers it is omitted unless `shareWithRemoteModels` is enabled. This check runs on worker recompilation too, so switching a worker to a remote backend does not automatically retain the local-only memory block. Ordinary recent history and existing project prompt behavior remain unchanged. Remote opt-in is treated as a risky workspace setting and cannot be enabled by an untrusted repository.

The Context IPC endpoint accepts only the main application's main frame, derives workspace scope in main, checks the thread exists and validates bounded control input. It never accepts an arbitrary filesystem path from the inspector.

Controls carry an optional revision for legacy compatibility; absent revision means the initial revision zero. SQLite checks the expected revision atomically, increments successful writes, and rejects stale changes with `CONTEXT_CONTROLS_CONFLICT`. Identical retries return the committed state without adding a revision. The inspector can reload saved state and retry instead of overwriting another edit.

## User controls

The chat header's **Context** button opens a keyboard-accessible inspector with focus ownership, Escape dismissal and focus restoration.

Users can:

- See retained versus total message count, coverage, logical usage and revision.
- Preview which facts a particular question would recall.
- Pin up to 100 notes of up to 2,000 characters each.
- Remove individual pins.
- Store up to 750 KB of serialized recall controls, with at most 10,000 excluded source IDs.
- Exclude an older source from additional memory recall.
- Set a cutoff that stops recalling existing older history and clears pins.
- Reload the RAM snapshot from the saved transcript.
- Disable RAM recall or change its limits in Settings → Agent.

These controls preserve the visible transcript. Excluding additional older recall does not delete the ordinary recent conversation window or erase secrets from existing chat history. Deleting the conversation removes its durable recall controls through the database foreign-key cascade and invalidates the RAM copy.

## Relationship to existing memory and diagnostics

`.eris/context.md` remains the existing project-summary/reference mechanism, with its separate auto/ask/off policy. RAM conversation recall does not silently write project summaries or promote assistant claims into project truth. The Summary extractor now handles a Summary section at end of file correctly, and its cache retains at most eight files no larger than 1 MiB each.

Existing run-local compaction and native inference sessions are separate mechanisms. This change leaves native per-run session release intact. There is no cross-turn KV reuse, background summarizer or model swap for memory maintenance.

Eris-Dev's independent question cases do not automatically consume production conversation memory. The shared compiler can expose a `memory` evidence block when supplied by a conversation-aware caller. The deterministic memory suites are included in the agents qualification profile used by normal builds. Live-model quality comparisons remain a separate evaluation; passing scripted tests does not establish that every model follows recalled instructions correctly.

## Verification and regression coverage

Automated coverage includes:

- A 25,000-message RAM snapshot with recall of a constraint buried near the beginning.
- A 10,001-message SQLite hydration, warm-cache reuse, eviction/recovery and durable pins.
- Canonical paging independent of renderer page size.
- Cross-thread/workspace keys and foreign-project task-receipt filtering.
- User/assistant trust labeling, secret-like omission and permission-precedence text.
- Monotonic revisions, duplicate append IDs and rewrite invalidation.
- Generation fencing for late hydration, unrelated-thread independence, clear, append and disable.
- Selection cancellation and clear races.
- Byte/count limits, partial coverage, idle expiration and LRU eviction.
- Consistent-revision retry, oversized-row cursor progress and reasoning omission.
- Durable controls on restart, validation and delete cascade.
- Production chat IPC integration with canonical history and a scripted runner.
- Reply persistence before terminal success and explicit storage-failure reporting.
- Native-local inclusion, remote omission and remote opt-in at worker prompt compilation.
- Untrusted workspace rejection of remote recall opt-in.
- Electron inspector preview/exclusion, modal focus, Escape and focus restoration.
- Bundled worker context paging/control request handling.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. For native UI/worker checks run `node scripts/check-client-workers.mjs` after building and `npm run check:accessibility`.

## Limits and future extensions

This implementation intentionally keeps runtime behavior bounded and testable. Semantic contradiction resolution, embeddings, multi-thread project fact promotion, file-content caches with repository fingerprints, comprehensive secret scanning and cross-turn native KV reuse are not implemented here. Very long messages, limited RAM budgets or very old conversations can produce partial coverage; the inspector and manifest disclose that limit.

A future project-memory service should use explicit fact provenance, repository revision/content fingerprints, user-approved promotion and a separate invalidation contract. It should not infer that an old successful task receipt verifies a newly edited file.
