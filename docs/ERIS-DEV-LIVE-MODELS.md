# Run question files through a model in Eris-Dev

Reviewed against integrated `main` `0a54629` on 2026-11-01 (package v0.6.10). The published v0.6.10 tag is `f14e409`; later source fixes require another build.

1. Open Eris-Dev and import the TXT, JSON or JSONL question file (up to 10,000 questions).
2. Choose a local or API **Model** in the toolbar, then click **Run questions**. Live model testing is the default. For request inspection without inference, choose **Capture requests only (no model)** in the same picker.
3. If you need another server, open **Settings → Connect a model server**, enter its API URL and optional key, then click **Connect**. Ollama commonly uses `http://localhost:11434/v1`.
4. Optional workspace selection, agent mode, context and question deadlines are under **Settings**. Defaults use the sample project, Agent mode, 8,192-token context and a three-minute deadline.
5. Questions run one at a time in batches of ten. Select any completed question to read its **Answer**. Use **Model request** for the messages sent, or **Debug details** for routing, tools and contract information.
6. Use **Stop run** to interrupt processing. **Past runs** lets you reopen results or resume an interrupted run. For a custom endpoint, reconnect after restarting the app before resuming.
7. **Export results** saves a JSONL file with automated redaction by default. Original and filtered exports, plus comparisons, are under **More options**.

## Execution and evidence

Choose a named model for a pinned comparison, or **Auto-local · production routing** to exercise the production local-model selector and eligible local recovery pool. Auto-local requests retain the router's selected worker at the provider boundary. Each request records its actual model, and latency records identify the execution worker. Cloud execution remains unavailable in this diagnostics mode. Native GGUF inference uses the same utility-process worker as Eris.

Quality-suite exports include newly created files observed in production progress receipts, alongside original fixture files, for independent review. Evidence reads remain inside the fixture, with 100-file and 2 MB limits and explicit omission lists. File contents and a completed response require independent grading before they can establish artifact correctness.

Each live question gets a fresh copy of the selected fixture/project, so edits cannot contaminate later questions. Diagnostics guards block host shell commands, web/MCP/image effects and background delegation. This mode records model and agent behavior; it cannot establish that generated code passes tests. Answer quality stays **not evaluated** until separately reviewed. Imported history belongs to its question; questions are not automatically combined into a conversation.

Limits: batches of ten with concurrency one; at most twelve model requests per question (including intent), ten agent steps, 250,000 output characters across model calls, and the selected overall question deadline. Intent resolution can use up to two minutes within that overall deadline to allow for cold local-model startup. API prompts and project excerpts are sent to the selected provider, using its configured credentials.

Runs are stored under the Eris-Dev application data `captures/<run-id>/` directory. The manifest includes model selection, limits, settings digest, fixture digest and build provenance. Individual case records and batch summaries (`batch-1.json`, etc.) are saved alongside the exportable JSONL. Batch summaries describe the portion executed in that invocation; per-case records remain the source of truth after resuming within a batch. Native model weights are reused; credentials are never stored in the run manifest or included as request headers in exports.

Resume rejects changed settings, fixture or harness fingerprints. A cancelled active question is preserved as an attempt and retried on resume. Completed errors remain evidence and are not automatically retried, avoiding repeated provider charges. A new run can be created for selected failed questions. Live provider calls can have costs; testing the harness with transport fixtures does not itself call paid providers or load a GGUF.

## Validation

Automated coverage includes actual production request serialization and SSE parsing with a controlled provider fixture, selected-model pinning, answer persistence, provider failure classification, cancellation, resumed batch boundaries, and 23 persisted results across batches of 10/10/3. The app's prebuild qualification runs these tests. A successful harness test is distinct from measuring a real model's answer quality.

## Automatic routing versus a pinned comparison

The production IDE's Agent Auto chooses a role independently of model policy. In Eris-Dev, a named model pins execution; Auto-local exercises the production local selection policy. Automatic remote selection is not exposed by this runner. Limits, redaction and diagnostics effect restrictions apply to both choices. Record the selected policy and actual per-call models when comparing runs.

Capture records are taken at the shared transport seam. Actual native/server payloads can be revalidated, budgeted and adapted afterward. Correlate dispatch metadata and source/model provenance when reviewing omitted RAM evidence. Refer to [the current architecture](ARCHITECTURE.md) and [memory guide](CONTEXT-MEMORY.md), particularly the parent-lease lifetime limit for asynchronous children.

### Routing and latency qualification

The agent build profile checks final agents, workspace bindings and edit authority for hand-labeled desktop turns, alongside the broader question corpus and workspace-edit smoke tests. The routing regressions also verify zero model classification calls for a standalone question, a single bounded same-model call for an ambiguous question, and conservative fallback when a provider ignores cancellation.

Live Eris-Dev JSONL rows include the time from case start to the first non-empty answer event, model preparation, prompt build, and tool time where available. Batch JSON reports include platform, architecture, and nearest-rank median and p95 per model and residency cohort. Native residency is sampled at case entry for the exact context profile. Server-side residency is reported as unknown. Batch percentiles use completed answers without a failing deterministic deliverable check. Keep failures in the case counts and report sample sizes alongside latency.

For release qualification, run the same hand-labeled cases with packaged Eris on Windows and macOS. Capture cold and warm starts separately, compare outcome and permission correctness before comparing latency, and retain the model, backend, and device profile alongside the results. Scripted cases exercise routing and effects but supply no live latency evidence.

The desktop classifier uses a 1.5-second deadline and a 96-token reply limit for unresolved turns. Native cold starts and Auto-selected remote destinations use the conservative fallback instead of sending a second request. Retry controls preserve the latest turn's in-session attachment references, editor snapshots, skill selection, and model policy. A retry appends a separate attempt and keeps the original checkpoints. These snapshots are held only for the latest submitted turn in the window.

Auto's short-answer preference requires comparable samples and a predicted first-output gain of at least 20 percent before changing the heuristic choice. It uses a rolling, in-process sample window for the active native settings profile. Workspace edits continue to use quality evidence. Opt-in outcome records count a verified edit only after a passing check on the last mutation, and elapsed time breaks ties between models with enough verified completions.
