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


## Supported Eris runtime adapter (REC-27)

In Eris-Dev, open **Quality suite · production runtime**, choose an installed/configured model, optionally choose a comparison model, set repeats and explicit provider-call/output budgets, then run. Host commands, networking tools, images and delegation stay blocked by diagnostics; unsupported fault injections are `not-exercised`, not successful correctness evidence. Reports archive their exact fixture pack and support reopening, export and digest-bound adjudication import.

For CLI use, build Eris-Dev or set `ERIS_DEV_EXECUTABLE` to its installed executable, then use the maintained adapter:

```sh
node scripts/run-quality.mjs --adapter checks/quality/eris-adapter.mjs \
  --models 'local:your-installed-model' --repeats 1 \
  --max-calls 60 --max-output-tokens 40960 --live --output /tmp/eris-quality.json
```

Model IDs are the same IDs used by the Eris-Dev picker. A call reservation covers up to six production requests (including routing/intent); output reservations are divided across those requests and reach both API and native transports. Missing usage remains unknown, not a zero-cost claim. The CLI starts a fresh Eris-Dev process per case; its latency includes cold startup. UI and CLI both invoke `captureQuestion`, preserving production contracts/call history rather than substituting a custom prompt. Compiled provider wire serialization is still owned by the production transport.

Live inference was not used to validate this implementation. Deterministic checks cover fixture isolation, traversal rejection, exact-secret/pattern redaction, reservation propagation, unsupported faults and a built headless zero-provider smoke. Human correctness remains unresolved until independently reviewed.
