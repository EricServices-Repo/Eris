# RAM-context qualification and release evidence (#147)

## Deterministic CI gate

`npm run check:context` writes version 2 observations to `out/qualification/context-gate-performance.json`. The corpus remains deterministic 1k/10k/25k/100k mixed code, metadata, Unicode and decision workloads; each corpus has a hash, offered/retained denominators and independent query samples. This command certifies scripted invariants only. Its output explicitly says that release qualification is separate.

Measurements now include cold installation, per-query selection, twenty equal-size warm appends, event-loop queue samples, and actual production task compilation of fourteen labeled recall cases. Recall must survive into the compiled model-facing text; selection alone is insufficient. The report samples logical owned/reserved/pinned peaks and peak simultaneous charged bytes, separately from retained heap deltas. These are logical ownership observations and sampled heap changes, not an OS/process peak-allocation measurement. The corpus fixture itself is outside the store ledger.

Invalid/NaN timings, sample/query denominator mismatches, duplicate workloads, over-envelope sampled allocation, leaked reservations, missing labels and relative query/append/queue regressions fail. Compilation uses the same production compiler; native destination classification is a pure shared helper, so the Node harness does not initialize the model runtime.

## Collect packaged observations

An explicit `--eris-context-qualification` application flag runs the same scripted workload in the real packaged Electron main process, in a disposable profile, without opening a workspace/window or loading a model. Set `ERIS_CONTEXT_OUTPUT` to an absolute JSON output path and execute the app's native executable:

```sh
ERIS_CONTEXT_OUTPUT=/tmp/macos-context.json /path/to/Eris.app/Contents/MacOS/Eris --eris-context-qualification
```

On Windows, set `$env:ERIS_CONTEXT_OUTPUT` and launch `Eris.exe --eris-context-qualification` from the packaged installation. The report contains build-stamped source SHA and dirty state, lockfile digest, executable entry digest, app/Electron/Node versions, CPU, platform, architecture and system RAM. `entrySha256` identifies the compiled main entry, not the whole installer. Unpackaged execution remains explicitly unqualified.

Run this on each designated reference machine; do not turn one machine's timings into another hardware profile. Add measured limits to `checks/performance/context-budgets.json`: exact CPU/platform/architecture, supported RAM range, per-workload selection/append/queue/heap-delta limits, and compilation p95. The profiles list intentionally remains empty until real reference-machine evidence exists.

## Live-model paired evidence

Scripted workloads make zero provider calls. They cannot certify answer quality. A release report additionally requires `liveModel` metadata from an independently completed, reviewed paired run: model name, weights SHA-256, backend fingerprint, cases/completed, and `paired` with cases, baselineCorrect, contextCorrect, seed, corpusHash, baselineWeightsSha256/contextWeightsSha256, baselineBackendFingerprint/contextBackendFingerprint, and sentSourceCases.

Within each platform, baseline/context runs must use identical weights and backend. Both platforms must use identical weights and labeled corpus; their backend fingerprints may differ because Metal/CUDA/CPU implementations differ. Every context case needs actual source-send coverage. Accuracy must meet the configured 0.95 threshold and cannot regress against baseline. Generated question counts, simulated answers and partial runs cannot fill these denominators. Include underlying run captures in review; the verifier validates the declared evidence contract, not whether a human fabricated a JSON file.

## Release enforcement

`npm run check:context:release` reads exactly two reports from `out/qualification/release-evidence`, requires macOS and Windows packaged evidence for the checked-out SHA, all four workloads/query matrices, clean build stamps, matched hardware budgets, and the completed frozen-model paired comparison. It refuses missing, mismatched or insufficient evidence and writes a verification result when reports are readable. Standard CI remains a deterministic gate; it never manufactures release certification.

Release workflow builds now depend on this verifier. Upload the two independently collected/qualified reports as an artifact named `ram-context-release-evidence` in this repository. Pass its workflow run ID as `context_evidence_run_id` for a manual release, or configure `RAM_CONTEXT_EVIDENCE_RUN_ID` for tag-triggered releases. The artifact must match the exact release source SHA. Missing evidence or empty hardware profiles deliberately block publication, including repair attempts; no bypass flag is provided.

## Acceptance limits and validation

Permanent tests cover malformed numeric data, partial matrices, missing packaged/hardware/live evidence, source/platform mismatches, actual compiled recall, transient reservations and positive/negative synthetic validator fixtures. Those fixtures are not packaged or live acceptance results. The performance UI availability guard now names the awaited state and uses a bounded wall-time deadline; the independent latency measurements and budgets remain enforced.

Windows hardware limits, real host-pressure safety and live answer improvement remain unmeasured until qualified evidence is supplied. No assertion that 10,000 cases called a real model is made.
