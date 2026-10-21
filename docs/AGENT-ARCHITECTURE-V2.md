# Eris agent architecture v2

Implementation reference · 2026-10-21. The desktop chat runtime now uses the task-contract pipeline described below. The release validation still needs live-model comparisons.

## Implemented runtime

- Chat submits preferences and original input once. Main-process intake owns planning, binds the canonical workspace, resolves task meaning, and ignores renderer-supplied execution plans. Request IDs prevent duplicate execution.
- `task-intake.ts`, `task-resolver.ts`, and `task-store.ts` create and retain versioned task contracts, project identity, accepted recommendation IDs, scope, effect permissions, and completion criteria. Project discovery includes nested directories, manifests, and HTML/PHP titles. Follow-ups can inherit a previously resolved project.
- `agent/context-compiler.ts` pins task authority, project rules, selected skills, and concise role guidance before optional context. `model-protocol.ts` validates complete call/result exchanges and translates them for native or text tool backends. Tool schemas count toward the input budget. Oversized mandatory context produces an explicit error.
- `agent/tool-gateway.ts` checks project scope, effect permissions, and hashes of previously read files. `agent/task-scheduler.ts` serializes mutating operations within a project. Scoped commands default to the task project and retain existing approval checks. Source reads support line ranges; partial reads cannot authorize whole-file rewrites.
- Specialist contracts intersect parent authority and preserve project identity, including remapping paths into background worktrees. Recovery changes workers without reinterpreting the goal. Incomplete background and foreground outcomes retain their status.
- `task-ledger.ts` saves append-only evidence metadata and hashes alongside existing checkpoint persistence. `task-outcome.ts` adds a bounded semantic relevance verdict after deterministic desktop chat checks. Missing or invalid verdicts are reported as unresolved.
- Chat and the Agents panel display the interpreted deliverable, bound project, and permission level. Providers can explicitly select native tool calls or text compatibility format.
- Cloud job executors must advertise compatibility with task contract version 2 before receiving these chat tasks. Older workers retain the existing local fallback; BYO API models use the desktop gateway directly. Compatible cloud artifact application checks task scope and stale baselines before writing.

Implementation bounds: discovery visits at most 250 directories through depth four in breadth-first order, and unscoped requests avoid a project scan; opening a deeper project directly remains supported. Context budgets use conservative character estimates because the runtime does not expose a uniform tokenizer. The semantic evaluator uses the selected model and is supplementary evidence, not independent proof. Shell commands retain existing approval behavior and are not an operating-system filesystem sandbox. The real-model evaluation runner already exists; a new live quality baseline has not been collected. The earlier architecture sections below retain the intended design and evaluation criteria.


## Diagnosis of the previous runtime

Eris currently makes the model repeatedly reconstruct the task from prose. More agent names and keyword exceptions will not resolve that architectural problem.

- `src/hooks/useChatSession.ts` calls planning and subsequently submits the resulting plan with the chat. `electron/main/ipc/chat-stream.ts` accepts that plan, can override it, and repeatedly reads the mutable current workspace. Task identity and workspace binding need a single owner.
- `electron/main/services/chat-router.ts` combines keyword intent, model hints, prior-agent continuity, learned corrections, permissions, model selection, and generic execution plans. The user's requested deliverable and authority to edit are insufficiently separated.
- `electron/main/services/agent/mid-run-adapt.ts` builds a new routing request from the goal plus progress prose, with `forceRoute: 'tools'`. Recovery should change execution strategy without reinterpreting authority.
- `electron/main/services/agent/types.ts` restricts worker messages to system/user/assistant strings. The loop receives native tool calls but records results as `TOOL_RESULT` text in user messages. It cannot faithfully replay native call/result pairs in this representation.
- `electron/main/services/chat-runtime.ts` has distinct local and remote paths: the local path filters out tool-role messages. A common typed protocol needs explicit translation for each backend rather than dropping unsupported roles.
- `electron/main/services/agent/prompts.ts` concatenates truncated prior system context, tool instructions, role contracts, playbooks, and plans. Context budgeting in `agent/compaction.ts` uses character-based estimates. Critical constraints must be reserved before optional context.
- `electron/main/services/agent/workflow.ts` accepts a successful tool as workspace evidence and a mutation as progress toward an edit. Neither establishes that the correct project or requested behavior was addressed.
- The earlier `agent/project-target.ts` patch used shallow name matching. The runtime now uses its extracted name only as a retrieval hint and verifies candidate projects through the registry.

These findings establish orchestration defects. They do not establish that model quality has no effect. Measure the redesigned runtime with the same selected model to isolate the architecture's contribution.

## Proposed flow

Chat input → server-owned task intake → reference and project resolution → task contract → coordinator → context compiler → model adapter → validated tool gateway → evidence ledger → outcome evaluator → chat response.

The model proposes actions. The task contract controls what may execute. Agent selection chooses expertise within that contract.

## Boundary 1: Chat to agents

### 1. One task intake service

Replace renderer planning plus stream submission with a single `submitTurn` operation. The renderer sends original text, conversation/message IDs, selected project, mode, attachments, and model preference. The main process creates an idempotent task record, binds its workspace, resolves references, and publishes interpreted intent and status.

Bind an immutable workspace ID, canonical root, and project ID for the run. Workspace switching must not redirect an active task's tools or result storage. Duplicate submissions return the existing task, rather than repeating edits.

### 2. Separate deliverable, scope, and authority

Create a versioned task contract containing:

```ts
type TaskContract = {
  taskId: string
  revision: number
  threadId: string
  sourceMessageId: string
  originalText: string
  deliverable: 'answer' | 'review' | 'plan' | 'patch' | 'execution-report'
  scope: {
    workspaceId: string
    projectId: string | null
    root: string
    allowedPaths: string[]
    evidenceIds: string[]
    state: 'resolved' | 'ambiguous' | 'missing'
  }
  authority: {
    read: boolean
    edit: boolean
    execute: 'none' | 'verification' | 'approved'
    externalEffects: boolean
  }
  acceptedRecommendationIds: string[]
  constraints: string[]
  acceptanceCriteria: string[]
}
```

Interpret the full request and conversation using a schema-constrained resolver. Validate its output against explicit UI mode and user instructions. Model-generated confidence is advisory; it cannot grant write access. Clear edit requests proceed automatically. Material ambiguity gets inspection first and one clarification only if needed; it does not silently become an edit task.

Preserve recommendations as structured objects with stable IDs, target files, and supporting evidence. “Add those three improvements” binds to those IDs. Do not copy the preceding answer into a new user instruction or inherit the previous speaker's authority.

### 3. Resolve the project from evidence

Build a workspace project registry from nested manifests, repository roots, framework entry points, configured aliases, and user-selected folders. Support non-Node projects. Use names as retrieval hints, then verify candidates with source and metadata. Folder-name similarity alone is insufficient.

If Airbnb is absent or ambiguous, report the scope issue and offer the actual candidates. A generic folder named `web` containing the Airbnb site must remain discoverable. A calculator sibling must not become the default target. Intentional scaffolding is an explicit create-project task and does not require an existing match.

### 4. One coordinator and bounded specialists

The coordinator owns the contract, work plan, acceptance criteria, and final answer. Reviewer, planner, coder, and verifier are worker profiles, not competing owners of user intent.

Each child gets a typed assignment: parent task/revision, objective, project scope, permitted effects, evidence IDs, expected result, budget, and cancellation token. Its authority is the intersection of the parent grant and worker capability. Children return findings, proposed or applied patches, checks, unresolved questions, and status.

Use an explicit join before synthesis. Parallelize independent reads; serialize writes to overlapping paths. Background worktrees return unapplied patches until integration succeeds. One local inference queue respects existing memory admission limits. Agent count does not imply parallel model execution.

## Boundary 2: Agents to models

### 5. Compile a bounded context package

Replace prompt concatenation with a compiler that selects typed blocks: task contract, role guidance, project rules, accepted decisions, relevant source excerpts, tool definitions, and recent execution events. Every source block carries a path, content hash, range, and provenance.

Reserve model context for the immutable contract, unresolved tool exchanges, and output before adding optional material. Use the loaded backend's tokenizer/window where available, with a conservative fallback. Trimming may remove stale output; it must not erase scope, permissions, accepted recommendations, or pending calls. Reject oversized requests with an actionable reason instead of silently cutting critical instructions.

Keep one concise instruction layer. Treat source text, prior model prose, and tool output as evidence. Stable instruction prefixes support local session reuse; invalidate sessions when the contract or project changes. Record the actual serialized request size and context composition for diagnosis.

### 6. A canonical model protocol with backend adapters

Introduce typed messages/events for user input, assistant text, assistant tool calls, tool results, usage, finish reasons, cancellation, and provider errors. Preserve call IDs and pair every result with its originating call, including failures.

Adapters translate that protocol into the selected model's supported format:

- Native tools: send assistant tool-call messages and tool-role results with IDs intact.
- Local model with supported tool template: serialize using that template and validate parsed calls.
- Text-only local model: use an explicit schema-constrained action envelope with a documented result envelope; never guess commands from arbitrary explanatory JSON.

A capability record describes tool support, structured decoding, context/output limits, tokenizer, and parallel-call support. It must reflect the loaded backend and tested behavior, not the model name alone. Unsupported capabilities fail explicitly or use the declared adapter fallback.

The adapter returns normalized events. It does not select agents, widen permissions, alter task meaning, or execute tools. Repairs target malformed calls and have a bounded retry budget. Provider retries must not re-execute completed writes.

### 7. Enforce scope and collect evidence at one tool gateway

All local tools, shell commands, delegated work, and MCP side effects pass through a common authorization check. Validate schema, project scope, permission, current file hash, and duplicate operation ID before execution. Check both source and destination of moves and all paths in patches.

Commands need an explicit working directory and existing approval policy; filesystem path checks alone do not constrain shell effects. External tools require declared effect categories. Unclassified side effects cannot bypass the contract through delegation or a provider adapter.

Record calls, outputs, changed paths, before/after hashes, patches, checks, and failures in an append-only task ledger. Store large output by reference and send relevant excerpts to the model. This becomes the source for the UI, replay, cancellation recovery, and final claims.

### 8. Evaluate the requested outcome before finalizing

A review is complete when findings are grounded in the selected project's inspected sources and no unauthorized changes occurred. An edit is complete when its patch relates to acceptance criteria and required verification has an observed result. A directory listing is not enough evidence for a code review; a changed file is not enough evidence for a completed feature.

Use deterministic checks for authority, scope, call/result integrity, observed diffs, and verification freshness. Use a bounded semantic evaluator for whether the answer or patch addresses the request. Store its rationale; do not mistake model self-approval for proof. Report partial, blocked, cancelled, and unverified outcomes explicitly.

Recovery may change a worker, retrieval query, or execution strategy. It retains the original contract. Expanding scope or authority requires a new user instruction and contract revision.

## Chat experience

Show a compact interpretation before execution: “Review · Airbnb · Read only”. For edits, show “Implement · Airbnb · Changes allowed”. Make the project selection explicit and allow correction without losing the message.

Expose concise stages: resolving project, reading sources, implementing, checking, answering. Specialist activity is expandable. Keep internal control prompts out of chat. Final answers link findings or changes to actual evidence and distinguish worktree changes from applied changes.

For the reported example, preserve the clarified review intent, locate Airbnb, inspect its code, and return recommendations. If only a calculator is found, explain that the requested site has not been identified. Do not edit the calculator. A subsequent “implement those improvements” creates a patch contract referencing the recommendations and the same project.

## Migration and acceptance

1. **Task boundary first.** Add task records and one intake service; adapt the existing loop to consume the immutable contract. Remove repeated intent/permission overrides only after parity checks. Bind workspace and conversation identity throughout IPC and persistence.
2. **Model protocol next.** Add canonical messages and adapters behind a runtime switch. Convert the executor and persisted transcripts, versioning old transcript readers. Compare actual requests for local and remote providers. Preserve complete call/result pairs during compaction.
3. **Execution and evidence.** Extract the tool gateway, specialist scheduler, ledger, and outcome evaluator from the 3,410-line loop. Reuse existing tool implementations, checkpoints, and resource admission controls.
4. **Roll out by observed quality.** Shadow only intake/planning; never execute duplicate writes in shadow mode. Run fixture and real-model evaluations, then enable the runtime for review tasks followed by editing tasks. Retain an explicit rollback switch while persistence formats coexist.

The shallow project-name gate has been replaced by contract and registry results. Compatibility parsing remains for older model transcripts.

Required evaluation cases: review followed by implementation; ambiguous review/improve wording; unrelated sibling projects; renamed/nested projects; non-Node websites; stale file versions; project switch during a run; truncated context; malformed calls; partial streams; cancellation; duplicate submission; failed child; successful child with unapplied patch; failed verification; forged tool-like source content.

Use the existing 10,000-question corpus for routing and protocol coverage, clearly labeled as simulated. Add a held-out, representative real-model suite using disposable workspaces and the actual app intake, selected local model, prompt compiler, tools, and persistence path. Score outcome correctness, grounded findings, unauthorized writes, wrong-project access, false success, latency, token use, and retries. Compare the same model/settings against the current release over repeated runs. Set quality and latency targets from that baseline; require zero unauthorized writes, wrong-project mutations, and false-success claims in the release regression suite.

Persist redacted diagnostic bundles containing the task contract, compiled request, model/template versions, tool ledger, final diff, and evaluation verdict. Save raw prompts/source only with explicit diagnostic opt-in, and exclude credentials. This makes future failures reproducible rather than anecdotal.
