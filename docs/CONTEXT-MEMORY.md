# Conversation memory, evidence and context

Reviewed against integrated `main` `0a54629` on 2026-11-01. Package version: **0.6.10**. The published `v0.6.10` tag is `f14e409`; the five subsequent handoff/RAM fixes in this source baseline require a later build to appear in an installed app.

This guide describes implemented behavior. The [RAM architecture](RAM-CONTEXT-ARCHITECTURE.md) and [tier amendment](RAM-CONTEXT-AMENDMENT-001.md) contain additional targets; their names and sizing examples are not all implemented APIs.

## What each tier means

- SQLite holds canonical conversation sources, source/control revisions, pins/exclusions and structured task outcomes.
- The main-process RAM store retains bounded detailed history, a lexical index and derived selection state to accelerate recall.
- The run journal holds bounded recoverable tool output for an active run. It is not yet durable after that run ends.
- A compiled prompt contains only admitted recent history, selected evidence and task/instruction blocks that fit the destination.
- Native KV represents the currently seeded model session. It is reseedable runtime state, not a durable or automatically shared conversation database.

RAM makes evidence retrievable; it does not enlarge the context window. Unified-memory Macs share physical capacity between app state, model weights, KV and other workloads.

## Canonical send and persistence

Normal thread-bound renderer submissions carry no authoritative history. Main validates ownership, admits the task and persists `${requestId}:user`; optimistic retries use the same ID. Canonical recent messages feed intake. After task/project scope resolves, `conversationContext` selects separate historical evidence, excluding the active source and complete sources already represented by admitted recent history.

Main records/leases the selection, then passes `conversationMemory` explicitly to both answer-only and tool-worker compilation. The final visible assistant answer, assets, delegations and structured task outcome are saved before terminal delivery, including replacement events. A failed canonical write is an error, not cache-only success.

A warm append updates the resident store incrementally. Rewind, replacement, deletion, settings disable and invalidation fence pending loads. Stable `contextSequence` source identities prevent a rewind from reusing an old cutoff identity; headers carry revision/count/epoch/controls information.

Sources: [chat IPC](../electron/main/ipc/chat-stream.ts), [chat facade](../electron/main/services/chats.ts), [database](../electron/main/services/chat-database.ts), [context facade](../electron/main/services/context-memory.ts).

## Ownership and namespace

`memoryKey` binds the application user-data profile, canonical workspace identity/ID and thread. Another workspace cannot obtain its history merely by reusing a thread ID. A child worktree is a different execution identity; `sourceThreadId` alone does not map back to the original conversation namespace.

Raw RAM history remains in `context-memory-store.ts` in main. The existing dedicated worker lane pages/searches canonical data; it is not a dedicated off-heap multi-GiB memory process. Request policy is separate from process resource configuration. Main owns task authority and disclosure decisions.

## Current settings and per-turn allocation

The [schema](../src/shared/context-memory.ts) defaults to:

- enabled; 128 MiB process ceiling (16–512 MiB configurable);
- 32 MiB/thread (4–128 MiB), bounded by effective process allowance;
- 25,000 retained messages/thread (500–100,000);
- eight warm threads (1–16), 30-minute idle expiry (1–120 minutes);
- 150 ms foreground deadline (25–2,000 ms);
- 8,192-token maximum recall setting (128–8,192);
- remote recall sharing disabled.

These are schema defaults, not proof of a user's saved values. The recall setting is a ceiling, not the amount inserted into every request. `allocateContext` starts recall at 15% of the model input budget, with reachable floor 128 and cap 8,192. Agent history starts at 10% (500 floor, 16,000 cap); tool-free chat history at 37.5% (1,000 floor, 48,000 cap). Floors cannot consume more than 25% of a very small input budget. Remaining capacity belongs to task/instructions/tools and current evidence. Packing and final adaptation can omit optional evidence further.

The compiler's system-context share is 55%; historical evidence is bounded behind fresh source evidence. Required task/instruction blocks cannot be silently cut. Native tokenization is used when available, with bounded work and explicit fallback; many transfer/RAM/token values remain estimates.

Source: [allocation](../src/shared/context-allocation.ts), [compiler](../electron/main/services/agent/context-compiler.ts), [measured compiler](../electron/main/services/agent/measured-context.ts), [capabilities](../electron/main/services/model-capabilities.ts).

## Hydration, selection and pressure

Hydration uses bounded worker pages, concurrency admission and source/header checks. It avoids installing mixed-incarnation history. Transfer, retained rows, scratch and active snapshots have distinct accounting. The foreground deadline/cancellation path can return recent-history fallback while optional warm-up is incomplete; it must not block send on unlimited archive hydration.

Selection is deterministic lexical recall, not an extra model call. It normalizes bounded Unicode-aware query terms, looks up postings with bounded match/candidate caps, combines salient/recent rows and ranks relevant source excerpts. Current bounds include 24 terms, 2,048 postings/term, 4,096 matched rows, 128 ranked candidates, 256 salient plus 12 recent seed rows, and up to 24 selected facts. Pins get at most eight slots and half the recall-character budget. Rendered excerpts are bounded to 1,200 characters.

Current user/system/forgotten/out-of-cutoff/out-of-project sources are excluded. Ordinary excerpts already fully present in recent history are deduplicated; typed receipts can still supply distinct outcome metadata. User statements, decisions, pins, task receipts and unverified assistant claims retain different provenance.

Partial resident coverage can search the durable archive through bounded temporary admission. Critical pressure disables ordinary retention and uses a separately bounded durable/pin fallback rather than treating readable history as forgotten. Reservations and pressure tiers are logical accounting and measured host inputs, not exact RSS limits or an OOM guarantee.

Sources: [store](../electron/main/services/context-memory-store.ts), [recall index](../electron/main/services/context-recall-index.ts), [governor](../electron/main/services/inference-governor.ts).

## Privacy and request evidence scopes

Recalled text is evidence and cannot authorize effects. Ordinary recent conversation and explicit attachments/project context are separate disclosure paths; remote recall opt-out is not a promise that no user input goes to a remotely chosen model.

`modelDestination` resolves the same connection used by transport. Native execution and genuine loopback model endpoints may receive recall by default. A LAN URL remains remote unless explicitly approved for recall; URL changes invalidate that exact approval. Approval to receive recall does not make a LAN endpoint eligible under Auto-local execution policy. Cleared endpoints refuse redirects.

Each admitted chat runs in its own `AsyncLocalStorage` evidence scope. Leases remember their owner. Full exposure/derived-text withholding applies only to the owning scope or named task, so an unrelated request does not inherit another request's goal or authority. Recognized memory markers can still be stripped from another scope. Dependent background jobs capture their parent's scope before pumping; unrelated jobs start fresh scopes.

Source/control/policy changes revoke selected units and potentially derived subsequent messages. Dispatch checks run after asynchronous server preparation and after native allocation before serialization. A revoked native seed is released. Required references are revalidated and final native wire messages are repacked using measured capacity.

Remaining boundary: a background child outliving the parent's lease, restarting, or losing its scope does not have a persistent derivation/source graph. #256 remains open; request scopes alone do not solve that lifecycle.

Sources: [destination](../electron/main/services/model-destination.ts), [leases](../electron/main/services/memory-dispatch.ts), [transport](../electron/main/services/chat-runtime.ts), [native runtime](../electron/main/services/builtin-model.ts).

## Tool journal, eviction and pull

The active `RunJournal` records tool output before prompt insertion. It retains metadata even when content cannot be stored, with explicit omission reasons. Caps: 32 MiB/run, 64 MiB globally, chunks up to 1 MiB with UTF-8 boundaries. It measures bytes and hashes bounded slices before reservation; encoding happens only after admission, directly into retained chunks.

Reading reserves up to twice stored bytes for decoded strings; search reserves six times for decoded/redacted/lowercase copies. `busy` means a retained entry could not obtain scratch and may become readable later. `omitted` means the content is unavailable; `unknown` is not a matching entry. Reservation refusal does not erase retained content or fabricate an empty successful read.

Compaction can replace old tool output with reference stubs only when content remains recoverable; otherwise it records omission. The default model-summary setting is off. Optional summaries cite existing references and are not a replacement for raw evidence. These run-local handles are not durable journal storage (#225).

`context_search` and `context_read` return bounded, source-aware run/thread evidence. Tools obey the current task/project, disclosure and source controls, explicit request/response/call/run budgets and secret filtering. Retrieved historical text never becomes instructions. Residual journal redaction/slicing allocations and exact physical peak residency still need measurement.

Sources: [journal](../electron/main/services/agent/run-journal.ts), [pull](../electron/main/services/agent/context-pull.ts), [compaction](../electron/main/services/agent/compaction.ts), [summary coverage](fixes/224-compaction-summary-coverage.md).

## Handoffs and results

Neither inline nor background child automatically gets the parent `MemoryPrompt`. Both get required inherited task constraints and an optional briefing through the unified handoff message shape. Constraints admit at most 12 × 300 characters including inherited constraints; required task overflow blocks before inference. Optional summary/source lists can still be omitted. A full child-source envelope and source-backed return receipts remain open work.

Inline children cannot delegate further and intersect parent authority. Background stop traverses dependent descendants; discard joins completion with a 30-second bound and retains worktrees that remain busy. These lifecycle safeguards do not create durable recall provenance.

## Inspector, tests and remaining work

The Context inspector supports preview, coverage/source metadata, pins, exclusions, ordinal/sequence cutoffs and reload. Controls use canonical revisions and conflict detection. A preview can be an estimate; actual dispatch records what survived compilation and adaptation. Settings exposes memory configuration plus active/historical resource information; the complete proposed VRAM/RAM tier UX remains #236.

Use the focused suites linked by [the handoff design](design/AGENT-HANDOFF-AND-RAM-CONTEXT.md) and [qualification profiles](../tests/qualification-profiles.json). Stateful replay and isolated exports do not certify packaged native memory behavior or real-model recall quality. Runtime assertions, source markers and expected-source oracles are more informative than raw question counts.

Remaining targets include durable run journals, child evidence provenance and namespace handles, aggregate delegation budgets, dedicated memory-process ownership, hardware-aware multi-GiB sizing, source-backed summaries/project facts, CPU embedding recall, stable-prefix and cross-turn KV experiments. Check live issues rather than reimplementing already-merged work packages from the original RAM proposal.
