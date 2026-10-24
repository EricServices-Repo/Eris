# Run question files through a model in Eris-Dev

1. Open Eris-Dev and import the TXT, JSON or JSONL question file (up to 10,000 questions).
2. Choose a local or API **Model** in the toolbar, then click **Run questions**. Live model testing is the default. For request inspection without inference, choose **Capture requests only (no model)** in the same picker.
3. If you need another server, open **Settings → Connect a model server**, enter its API URL and optional key, then click **Connect**. Ollama commonly uses `http://localhost:11434/v1`.
4. Optional workspace selection, agent mode, context and question deadlines are under **Settings**. Defaults use the sample project, Agent mode, 8,192-token context and a three-minute deadline.
5. Questions run one at a time in batches of ten. Select any completed question to read its **Answer**. Use **Model request** for the messages sent, or **Debug details** for routing, tools and contract information.
6. Use **Stop run** to interrupt processing. **Past runs** lets you reopen results or resume an interrupted run. For a custom endpoint, reconnect after restarting the app before resuming.
7. **Export results** saves a JSONL file with automated redaction by default. Original and filtered exports, plus comparisons, are under **More options**.

## Execution and evidence

Live mode uses the selected model for both semantic intent requests and agent requests through the production provider transport. The production router still decides when an intent call is unnecessary. The selected model is pinned across the run; automatic model substitutions and Cloud Composer handoffs are disabled. Native GGUF inference uses the same utility-process worker as Eris.

Each live question gets a fresh copy of the selected fixture/project, so edits cannot contaminate later questions. Diagnostics guards block host shell commands, web/MCP/image effects and background delegation. This mode records model and agent behavior; it cannot establish that generated code passes tests. Answer quality stays **not evaluated** until separately reviewed. Imported history belongs to its question; questions are not automatically combined into a conversation.

Limits: batches of ten with concurrency one; at most twelve model requests per question (including intent), ten agent steps, 250,000 output characters across model calls, and the selected overall question deadline. Intent resolution can use up to two minutes within that overall deadline to allow for cold local-model startup. API prompts and project excerpts are sent to the selected provider, using its configured credentials.

Runs are stored under the Eris-Dev application data `captures/<run-id>/` directory. The manifest includes model selection, limits, settings digest, fixture digest and build provenance. Individual case records and batch summaries (`batch-1.json`, etc.) are saved alongside the exportable JSONL. Batch summaries describe the portion executed in that invocation; per-case records remain the source of truth after resuming within a batch. Native model weights are reused; credentials are never stored in the run manifest or included as request headers in exports.

Resume rejects changed settings, fixture or harness fingerprints. A cancelled active question is preserved as an attempt and retried on resume. Completed errors remain evidence and are not automatically retried, avoiding repeated provider charges. A new run can be created for selected failed questions. Live provider calls can have costs; testing the harness with transport fixtures does not itself call paid providers or load a GGUF.

## Validation

Automated coverage includes actual production request serialization and SSE parsing with a controlled provider fixture, selected-model pinning, answer persistence, provider failure classification, cancellation, resumed batch boundaries, and 23 persisted results across batches of 10/10/3. The app's prebuild qualification runs these tests. A successful harness test is distinct from measuring a real model's answer quality.
