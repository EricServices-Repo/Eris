# Quality comparisons

`cases.json` is a versioned stratified fixture pack. Its obligations are independent
of model replies. JSON equality can establish correctness for the exact JSON case;
other cases require human adjudication. Syntax, topic words and a passing transport
capture do not establish semantic correctness.

Run `npm run check:quality` for deterministic harness tests. They make no model calls.
For an opted-in comparison, supply a trusted local adapter module exporting `kind`
(`scripted` or `live`) and async `run({test, model, repeat, maxCalls,
maxOutputTokens, signal})`. It must enforce one provider call per invocation, the
output cap and cancellation, materialize project fixtures in isolated roots,
respect task effect constraints, record observed routing/execution, and return:

- `answer`, `completion` (`complete` or an explicit incomplete/failure state).
- `effectiveSettings` including backend/context/output/protocol and fixture identity.
- Optional `usage` with token counts, measured/estimated source and observed cost.

Never include credentials or full secret-bearing settings in results. The runner
never executes returned code. Recovery cases require the adapter to inject the
named fault and record what happened; a normal reply is not recovery evidence.

```sh
node scripts/run-quality.mjs --adapter /absolute/path/adapter.mjs \
  --models model-one,model-two --repeats 2 \
  --max-calls 40 --max-output-tokens 163840 \
  --live --output /tmp/eris-quality.json
```

Live adapters require `--live`. The harness reserves each requested output cap
before invocation, caps the total call count, records deadlines/errors and marks
unrun cases `budget-skipped`. The adapter is trusted code and must enforce the
provider limits; these reservations are not a monetary billing guarantee.

Reports preserve routing/applicability/execution/completion observations separately
from correctness, with per-case latency, effective settings, usage, fixture digest
and model/repeat identity. Missing observations remain missing. Do not compare
runs with different fixture digests or silently substitute models/settings.

Human adjudication JSON is keyed by `case:model:repeat` and contains `state`
(`correct`/`incorrect`), `reviewer`, `rationale`, and the exact `resultDigest` in the
report. Supply it with `--adjudications /absolute/path/decisions.json`. Changed or
incomplete outputs cannot inherit an earlier correctness decision. No live
baseline has been established by the deterministic harness tests.

Apply decisions to the saved evidence without running a model again:

```sh
node scripts/run-quality.mjs --adjudicate /tmp/eris-quality.json \
  --adjudications /absolute/path/decisions.json --output /tmp/eris-quality-reviewed.json
```

Offline adjudication verifies the fixture and result digests before accepting a
decision. It never imports an adapter or makes another provider call.

## Multi-turn scenario matrices (REC-28)

`scenarios.json` is a separately versioned family pack: actual review → selected subset → implementation → diff explanation, review-only follow-ups, missing projects, an unrelated calculator versus a requested rental website, design, security and controlled provider/cancellation/cold-load cases. Development and held-out paraphrases have separate run identities. These synthetic projects are disposable; this runner does not mutate a user's project or run generated code in a host shell. The production adapter reuses `captureQuestion`, production intake, task completion and model transport. One session owns the same fixture across turns and carries the actual prior answer, completed TaskContract and file state; it never substitutes a canned assistant review.

Build Eris-Dev (`npm run build:dev-app`), then run:

```
npm run quality:scenarios -- --config comparison.json --output private-comparison.json
```

Example config (model IDs come from Eris-Dev's model selector):

```json
{"live":true,"models":["local:your-model"],"context":8192,"repeats":2,"maxCalls":120,"maxOutputTokens":200000,"seed":"comparison-1","split":"heldout","timeoutMs":90000}
```

Use the real selected model ID; the example is not a model alias. Comparisons reserve up to six internal provider calls per turn and an enforced per-call share of output tokens. Reservations are conservative; absent token/cost telemetry stays unknown. Seeded strata order and round-robin model turns make incomplete coverage explicit. Configuration has no default authorization for inference. This development-only Electron entry reads the installed Eris model configuration and credentials in the main process; reports redact paths and known secrets and omit full settings. Reports still contain private answers/source and should be reviewed before sharing.

**Merge dependency:** issue #72 / REC-27 supplies enforced API/native output limits. Without its `CAPTURE_OUTPUT_LIMIT_VERSION` marker, the maintained adapter returns `not-exercised` with zero provider calls, even if live execution was requested. It never runs an unbounded comparison as a fallback. Cold-load eviction is deliberately unavailable: it is reported as not exercised rather than calling a warm run cold. Provider-error and cancellation controls inject at the agent transport before its provider invocation, label that evidence, and retain earlier intent-call accounting; they do not pretend an actual provider outage occurred.

Reports separate route, applicability, edit/execution authority, artifact completeness, correctness, latency and cost. Each selected arithmetic recommendation has its own artifact digest and independent input/output observations. A restricted syntax interpreter evaluates only numeric/parameter arithmetic; it never executes generated source or host APIs. It cannot establish surrounding module safety or broad program correctness. Subjective review/design/diff obligations remain unresolved for an independent reviewer. Supply `adjudications` keyed by the report row key with `state`, `reviewer`, `rationale`, `resultDigest` and `packDigest`; changed evidence invalidates the decision. General quality pass rate is always unavailable: request counts, completed transport and topic words do not establish semantic correctness.

`npm run check:quality` also exercises matrix/history/oracle invariants with an explicitly scripted adapter. Those checks and the 10,000-question capture corpus are not live model quality evidence. Production-adapter tests mock only the provider transport; no paid inference is performed by CI. Timeout/cancellation signals belong to the current session; fixture cleanup waits for an in-flight capture to settle, retaining the fixture and reporting a cleanup error if it cannot settle promptly. Native workers are disposed by the headless entry on exit.
