# #218 — budgets follow the context actually allocated

`resolveModelCapabilities()` used the configured ceiling, while the runtime could allocate far less. A 9 GiB model on a 12 GiB GPU compiled for about 21,000 prompt tokens into a window of at most 8,192.

Native loads now report their allocation: context size, train size, GPU layers and total layers. `model-runtime.ts` holds this for the one resident model, and it is cleared on dispose and worker exit. Capacity resolves in order:

1. `measured-allocation`: the loaded model's real context.
2. `runtime-plan`: what `contextPlan()` will request, using the last known VRAM budget.
3. `configured-ceiling`: remote or unknown models.

`local:` models previously skipped the plan entirely and now use it. Each `context-compiled` event records `context: { source, tokens }`.

Known limit: the first request of a cold load is compiled from the plan before load finishes. If the runtime then allocates below the plan, that one request can still exceed the window. Later steps re-read capacity, and #230 should close this by loading first. A context recreated during worker recovery keeps the same min/max but its new size is not re-reported.

Verification: `npx vitest run tests/model-context-allocation.test.ts`. Real load reporting is typechecked but has not been exercised on a packaged build.
