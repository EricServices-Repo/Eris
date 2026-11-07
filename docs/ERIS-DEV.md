# Eris-Dev: model and agent debugging

Reviewed against integrated `main` `0a54629` on 2026-11-01 (package v0.6.10). The published v0.6.10 tag is `f14e409`; later source fixes require another build.

Eris-Dev is a separate Electron app (`app.eris.dev`) with its own data/profile and no production updater registration. It shares production chat intake, task contracts, prompt compilation, agent loop and model transport. It is not a second independent implementation of agent behavior.

## Choose the kind of evidence

- **Capture requests only:** no real inference. Capture common transport requests and supply labeled semantic-intent fixtures; stop at the first agent request. A response is not generated.
- **Run questions with a selected model:** opt-in real native/API inference through production provider transport, including subsequent bounded tool steps in a temporary workspace. A named model pins execution. Auto-local uses the production eligible local-model selector, and each captured call records its actual worker.
- **Stateful memory scenarios:** explicit test continuity over an isolated thread, source history and prior task, rather than automatically joining unrelated imported questions.
- **Quality scenarios:** budgeted synthetic fixtures, task/deliverable evidence and separately reviewed results. A green request invariant is not an answer-quality score.

The short [live-model guide](ERIS-DEV-LIVE-MODELS.md) covers normal use; [diagnostics](DIAGNOSTICS-RUNS.md) explains how the shared seam differs from full desktop execution.

## Import and normal run

1. Import TXT, JSON or JSONL containing 1–10,000 questions. JSON accepts strings and supported question/text records; JSONL can carry deliberate per-question history. Stable IDs retain original source associations across export/comparison. Document headings are not executable instructions.
2. Select the local/API model to run, or choose **Capture requests only (no model)**. Live model testing and capture are distinct modes; do not describe every export as simulated or every request as answered.
3. Use Settings for sample/no-project/copied-project fixtures, Ask/Agent mode, context budget, deadlines and an optional model server. Project copying is bounded (3,000 entries / 20 MB), omits unsafe categories and reports omissions; it is not a view into a live production workspace.
4. Click **Run questions**. Cases run sequentially in batches of ten with durable per-case progress. Independent cases get fresh fixture copies; explicit stateful scenarios are the exception.
5. Inspect **Answer**, **Model request** and **Debug details**. Requests distinguish intent/route/agent/outcome/compaction stages as applicable, tools, model/agent identity, task, findings, coverage and termination.
6. Stop/cancel, reopen **Past runs** or resume compatible interrupted runs. Resume validates settings/model/protocol/fixture provenance rather than silently mixing different source configurations.
7. Export redacted results by default. Original/filtered exports and comparison tools require attention to prompt/source content; redaction is heuristic, not a guarantee that arbitrary private data was removed.

Sources: [import](../electron/dev/questions.ts), [runs](../electron/dev/runs.ts), [batches](../electron/dev/batches.ts), [capture/runtime adapter](../electron/dev/capture.ts), [renderer](../src/eris-dev/main.tsx).

## Result dimensions and limits

Each record distinguishes boundary reachability, request coherence, inference status and answer-quality status. Capture-only records have no model response; live records contain bounded model output, inference timing and termination/error data. `answerQuality` remains `not-evaluated` until independent review/oracles provide separate evidence. A visually plausible answer or reported DONE is not a verified patch.

Default live settings use 8,192 context and a three-minute question deadline; capture-only timeout is 30 seconds. Live semantic resolution can use up to two minutes within the overall question deadline for cold startup. Live execution is bounded to twelve model calls including intake, ten agent steps and 250,000 output characters across calls. Scenario/quality adapters can use their own explicit caps; consult the manifest rather than assuming these defaults apply to every profile.

The ordinary model picker selects an exact native/API model. `capture.ts` pins live transport calls to that selected model, so the standard live corpus run is not an Auto-local/Auto-any comparative routing benchmark. Production automatic-selection/handoff tests exercise the shared plan/loop separately. Direct debug runners exclude the Cloud-only adapter.

## What is actually exercised

Production intake, contracts, role/model preferences, prompt/tool visibility, native/API inference in live mode, bounded worker steps, answer repair and temporary filesystem edits can be inspected. Capture stops before provider-specific serialization. Live requests recorded at the common seam can still be adapted/repacked by provider/native transport; distinguish those bodies from the correlated actual dispatch manifest, especially after native allocation.

Diagnostics guards refuse host shell/verification effects, web/MCP/image effects, persistent background delegation and Cloud inline execution at service boundaries. Workspace source tools operate only in the disposable snapshot. Replay does not grant approvals. This means Eris-Dev cannot prove that generated code passes its real build, that production approvals/UI delivery work, or that a background task tree integrates correctly.

The complete multi-agent RAM task-tree replay remains #267. Existing stateful scenarios and controlled child fixtures are useful foundations, not that entire acceptance profile.

## Models, shared installs and credentials

Eris-Dev discovers its own ready catalogs plus borrowed Eris model roots/catalogs. Eris-owned weight files are read directly and treated as borrowed/read-only; no Windows symlink permission is required. New downloads/deletes belong to Eris-Dev's own catalog. Legacy catalog symlinks are replaced safely instead of writing through into the production install.

Native GGUF inference uses the same utility-process implementation as Eris, including resource admission, measured allocation, tokenizer fallback, context-size retry and worker-error handling. A ready catalog entry is not proof that the full requested context fits current VRAM.

Live model discovery reads Eris's saved model-connection configuration. Main resolves the chosen credential through the credential abstraction; stored secrets are never returned through IPC or included in manifests. Temporary custom endpoint credentials are session-scoped and must be reconnected after restart. Capture-only settings remove connections and carry a simulated marker; losing the scripted scope must fail instead of reaching a provider or loading a model.

Sources: [dev model selection](../electron/dev/models.ts), [shared discovery fix](fixes/eris-dev-shared-model-discovery.md), [native runtime](../electron/main/services/builtin-model.ts), [credentials](../electron/main/services/credential-store.ts).

## Persistence and exports

Runs live under Eris-Dev's `captures/<run-id>/`, with a manifest, per-question records and batch/progress files. Results load on demand rather than keeping every prompt in React. Run headers identify source/build, corpus, model selection, settings/fixture digests, limits and processed/exported/total coverage. Older records are read with explicit missing-response semantics; do not reinterpret a v1 capture as a live answer.

Inspect `sourceMode`, timing, response reason and inference fields instead of assuming all v2-shaped exports share one mode. Keep exact source/model/runtime identity when comparing results. Sanitized stable IDs support comparisons without using transient task IDs, absolute scratch paths or timing as behavioral differences.

## Builds and qualification

- `npm run build:dev-app`: dev-app qualification plus main/preload/renderer/worker bundles.
- `npm run dist:dev-app:mac`: macOS app directory under `dist-dev/mac-arm64/Eris-Dev.app`.
- `npm run start:dev-app`: package and open the macOS app.
- `npm run dist:dev-app:win -- --publish never`: Windows x64 NSIS installer under `dist-dev/`; run on Windows so the owned-command helper is prepared.
- `npm run test:dev-app`: deterministic import/capture/live-adapter/stateful/quality scenarios listed in qualification profiles.

PR CI builds the Windows dev installer artifact. Release CI attaches `Eris-Dev-<version>-win-x64-setup.exe` alongside Eris installers; Eris-Dev does not consume the production update feed. These workflows do not make a local build a published release or certify an installed model's answer quality.

See [architecture](ARCHITECTURE.md), [test profiles](../tests/qualification-profiles.json), [release workflow](../.github/workflows/release.yml) and [build configuration](../eris-dev-builder.json).
