# #259 — Recheck recall after asynchronous preparation

Most of this issue was closed by `1bd3eef`, after the audit: `streamProviderChat` now reruns eligibility after `prepareModelWindows`, and the native route reruns it after the model loads. This change finishes what that left open.

- **Cancellation.** Eligibility can wait on the canonical source, and nothing after it awaits before the provider call. A request cancelled during that check now stops there, on both routes, instead of reaching the adapter.
- **In-process route.** Building the JSON grammar was an await after the final check, so a source could be revoked between the two. The grammar is now built first, which leaves the check as the last await before the prompt.
- **Coverage the issue asked for.** Revoking endpoint approval during preparation, dispatch counts for the filtered payload, a probe outstanding when the source is forgotten, and a capability-cache hit. The probe tests run the real `prepareModelWindows` over a stubbed `fetch`.

## Known limits

- The check is the last await in the app. A source forgotten after the request is on the wire cannot be recalled.
- The in-process reorder is typechecked but was not run: that path needs a real model, and the tests stub `streamBuiltinChat`.

No real provider or model was called.

Verification: `npx vitest run tests/memory-dispatch.test.ts`.
